/**
 * Backfill coupon redemption spend into daily_marketing_spend (Turso).
 *
 * Pulls GET_COUPON_PERFORMANCE_REPORT from SP-API in 30-day chunks
 * (Amazon's max window for this report type) and upserts into
 * daily_marketing_spend with marketplace = 'amazon_vendor'.
 *
 * Usage:
 *   node scripts/backfill-coupon-spend.mjs                        # last 90 days
 *   node scripts/backfill-coupon-spend.mjs 2025-01-01 2025-06-25  # custom range
 *   node scripts/backfill-coupon-spend.mjs 2025-04-01              # start → today
 *
 * Reads credentials from .env.local automatically.
 * All upserts are idempotent — safe to re-run.
 */

import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';
import { gunzipSync } from 'zlib';

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------
const envPath = new URL('../.env.local', import.meta.url).pathname;
const envLines = readFileSync(envPath, 'utf8').split('\n');
for (const line of envLines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  let val = trimmed.slice(eq + 1).trim();
  // Strip surrounding quotes added by some .env editors ("value" or 'value')
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (!process.env[key]) process.env[key] = val;
}

// ---------------------------------------------------------------------------
// Config / validation
// ---------------------------------------------------------------------------
const TURSO_URL   = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const CLIENT_ID   = process.env.AMAZON_VENDOR_CLIENT_ID;
const CLIENT_SEC  = process.env.AMAZON_VENDOR_CLIENT_SECRET;
const REFRESH_TOK = process.env.AMAZON_VENDOR_REFRESH_TOKEN;
const SP_API_BASE = 'https://sellingpartnerapi-na.amazon.com';

const missing = [
  'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN',
  'AMAZON_VENDOR_CLIENT_ID', 'AMAZON_VENDOR_CLIENT_SECRET', 'AMAZON_VENDOR_REFRESH_TOKEN',
].filter((k) => !process.env[k]);

if (missing.length) {
  console.error('❌  Missing env vars:', missing.join(', '));
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const argStart = process.argv[2];
const argEnd   = process.argv[3];

// Coupon report doesn't have the same ~4-day lag as ARA, but use yesterday to be safe
const SAFE_END = daysAgo(1);

let rangeStart = argStart ?? daysAgo(90);
let rangeEnd   = argEnd   ?? SAFE_END;

if (rangeEnd > SAFE_END) {
  console.warn(`⚠   End date ${rangeEnd} clamped to ${SAFE_END}`);
  rangeEnd = SAFE_END;
}

if (rangeStart >= rangeEnd) {
  console.error(`❌  Start (${rangeStart}) must be before end (${rangeEnd})`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Slice into 30-day windows (Amazon's max for coupon report)
// ---------------------------------------------------------------------------
function buildWindows(start, end) {
  const windows = [];
  let cursor = start;
  while (cursor < end) {
    const windowEnd = new Date(cursor);
    windowEnd.setDate(windowEnd.getDate() + 29); // +29 = 30 days inclusive
    const windowEndStr = windowEnd.toISOString().slice(0, 10);
    windows.push({
      start: cursor,
      end: windowEndStr < end ? windowEndStr : end,
    });
    const next = new Date(windowEndStr);
    next.setDate(next.getDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }
  return windows;
}

// ---------------------------------------------------------------------------
// LWA token (cached, auto-refreshed)
// ---------------------------------------------------------------------------
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 30_000) return cachedToken;

  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: REFRESH_TOK,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SEC,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LWA token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
  return cachedToken;
}

// ---------------------------------------------------------------------------
// SP-API helpers
// ---------------------------------------------------------------------------
async function spApi(method, path, body, retries = 3) {
  const token = await getAccessToken();
  const res = await fetch(`${SP_API_BASE}${path}`, {
    method,
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  // Retry on 429 with exponential backoff
  if (res.status === 429 && retries > 0) {
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '60', 10);
    const waitMs = retryAfter * 1000;
    process.stdout.write(`\n    ⏳  Rate limited (429) — waiting ${retryAfter}s before retry (${retries} left)...`);
    await sleep(waitMs);
    return spApi(method, path, body, retries - 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SP-API ${method} ${path} (${res.status}): ${text.slice(0, 400)}`);
  }
  return res.json();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pollUntilDone(reportId, maxAttempts = 30, intervalMs = 8_000) {
  for (let i = 0; i < maxAttempts; i++) {
    const data = await spApi('GET', `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`);
    const status = data.processingStatus;
    process.stdout.write(` ${status}`);
    if (status === 'DONE') return data.reportDocumentId;
    if (status === 'FATAL' || status === 'CANCELLED') {
      // Fetch the error document for the actual Amazon error message
      let errorDetail = '';
      if (data.reportDocumentId) {
        try {
          const errText = await downloadDocument(data.reportDocumentId);
          errorDetail = ` | Amazon error: ${errText.slice(0, 600)}`;
        } catch { /* ignore secondary fetch failure */ }
      }
      throw new Error(`Report ${reportId} ended with ${status}${errorDetail}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`Report ${reportId} timed out after ${maxAttempts} polls`);
}

async function downloadDocument(docId) {
  const meta = await spApi('GET', `/reports/2021-06-30/documents/${encodeURIComponent(docId)}`);
  const res  = await fetch(meta.url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (meta.compressionAlgorithm === 'GZIP') {
    return gunzipSync(buf).toString('utf-8');
  }
  return buf.toString('utf-8');
}

// ---------------------------------------------------------------------------
// Parse coupon TSV report
// ---------------------------------------------------------------------------
function parseCouponReport(tsv) {
  const lines = tsv.trim().split('\n');
  if (lines.length < 2) return new Map();

  const headers = lines[0].split('\t').map((h) => h.trim().toLowerCase());
  const dateIdx  = headers.findIndex((h) => h.includes('date'));
  const spendIdx = headers.findIndex(
    (h) => h.includes('coupon redemption cost') || h.includes('redemption cost') || h.includes('coupon spend')
  );

  if (dateIdx === -1 || spendIdx === -1) {
    console.warn('\n⚠   Unexpected coupon report columns:', headers.join(' | '));
    console.warn('    Looked for: date column + "coupon redemption cost" / "redemption cost" / "coupon spend"');
    return new Map();
  }

  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols     = lines[i].split('\t');
    const rawDate  = cols[dateIdx]?.trim();
    const rawSpend = cols[spendIdx]?.trim().replace(/[^0-9.-]/g, '');
    if (!rawDate || !rawSpend) continue;

    // Normalise MM/DD/YYYY → YYYY-MM-DD
    let date = rawDate;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(rawDate)) {
      const [m, d, y] = rawDate.split('/');
      date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }

    const spend = parseFloat(rawSpend) || 0;
    map.set(date, (map.get(date) ?? 0) + spend);
  }
  return map;
}

// ---------------------------------------------------------------------------
// DB upsert
// ---------------------------------------------------------------------------
async function upsertCouponSpend(spendMap) {
  if (!spendMap.size) return 0;

  const rows = [...spendMap.entries()];
  await db.batch(rows.map(([date, coupon_spend]) => ({
    sql: `INSERT INTO daily_marketing_spend
            (id, date, ad_spend, coupon_redemption_spend, marketplace, updated_at)
          VALUES (?, ?, 0.0, ?, 'amazon_vendor', unixepoch())
          ON CONFLICT(date, marketplace) DO UPDATE SET
            coupon_redemption_spend = excluded.coupon_redemption_spend,
            updated_at              = unixepoch()`,
    args: [`${date}|amazon_vendor`, date, Math.round(coupon_spend * 100) / 100],
  })));

  return rows.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const windows = buildWindows(rangeStart, rangeEnd);

  console.log('\n🎟   Coupon Spend Backfill → Turso');
  console.log(`    Range   : ${rangeStart} → ${rangeEnd}`);
  console.log(`    Windows : ${windows.length} × 30-day chunks`);
  console.log(`    DB      : ${TURSO_URL}`);
  console.log();

  // Row count before
  const before = await db.execute(
    `SELECT COUNT(*) as cnt FROM daily_marketing_spend
     WHERE marketplace = 'amazon_vendor' AND coupon_redemption_spend > 0`
  );
  console.log(`    Coupon rows in DB before: ${before.rows[0].cnt}\n`);

  let totalDates = 0;
  let totalSpend = 0;
  const errorWindows = [];

  for (let i = 0; i < windows.length; i++) {
    const { start, end } = windows[i];
    process.stdout.write(`  [${i + 1}/${windows.length}] ${start} → ${end}  requesting`);

    try {
      // GET_COUPON_PERFORMANCE_REPORT requires campaign date range in reportOptions,
      // NOT in top-level dataStartTime/dataEndTime.
      const { reportId } = await spApi('POST', '/reports/2021-06-30/reports', {
        reportType: 'GET_COUPON_PERFORMANCE_REPORT',
        reportOptions: {
          campaignStartDateFrom: `${start}T00:00:00Z`,
          campaignStartDateTo:   `${end}T23:59:59Z`,
        },
        marketplaceIds: ['ATVPDKIKX0DER'],
      });

      process.stdout.write(` [${reportId.slice(-8)}] polling`);
      const docId = await pollUntilDone(reportId);
      process.stdout.write(` downloading`);
      const tsv = await downloadDocument(docId);

      const spendMap = parseCouponReport(tsv);
      const n = await upsertCouponSpend(spendMap);

      const windowTotal = [...spendMap.values()].reduce((a, b) => a + b, 0);
      totalDates += n;
      totalSpend += windowTotal;

      console.log(` ✓  ${n} dates, $${windowTotal.toFixed(2)}`);
    } catch (err) {
      const msg = err.message;
      const isAccessDenied = /403|access.?denied|not.*approved|unauthorized/i.test(msg);
      if (isAccessDenied) {
        console.log(` ACCESS_DENIED`);
        console.error('\n❌  SP-API returned 403 for GET_COUPON_PERFORMANCE_REPORT.');
        console.error('    This report requires the "Coupon" Vendor Central role to be granted');
        console.error('    in Seller/Vendor Central → Apps & Services → Authorize apps.');
        process.exit(1);
      }
      console.log(` ERROR: ${msg}`);
      errorWindows.push({ window: `${start}→${end}`, error: msg });
    }

    if (i < windows.length - 1) {
      process.stdout.write('    ⏳  waiting 8s...\n');
      await sleep(8_000);
    }
  }

  // Summary
  const after = await db.execute(
    `SELECT COUNT(*) as cnt FROM daily_marketing_spend
     WHERE marketplace = 'amazon_vendor' AND coupon_redemption_spend > 0`
  );
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`✅  Done`);
  console.log(`    Dates upserted      : ${totalDates}`);
  console.log(`    Total coupon spend  : $${totalSpend.toFixed(2)}`);
  console.log(`    Coupon rows in DB   : ${after.rows[0].cnt}`);

  if (errorWindows.length) {
    console.log(`\n⚠   ${errorWindows.length} window(s) failed:`);
    for (const { window, error } of errorWindows) {
      console.log(`    ${window}: ${error}`);
    }
  }
}

main().catch((err) => {
  console.error('\n💥  Fatal:', err.message);
  process.exit(1);
});
