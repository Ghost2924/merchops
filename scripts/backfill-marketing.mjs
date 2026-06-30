#!/usr/bin/env node
/**
 * backfill-marketing.mjs
 *
 * Backfills asin_promotion_metrics from SP-API using:
 *
 *   GET_PROMOTION_PERFORMANCE_REPORT  → asin_promotion_metrics
 *                                     → daily_marketing_spend (aggregated)
 *
 * SP-API limits each request to a max 31-day window for ARA report types.
 * This script slices the date range into 30-day chunks and fetches each
 * chunk sequentially (to avoid 429s on report creation).
 *
 * Usage:
 *   node scripts/backfill-marketing.mjs
 *       → defaults: last 90 days
 *
 *   node scripts/backfill-marketing.mjs --days 180
 *       → last 180 days
 *
 *   node scripts/backfill-marketing.mjs 2025-01-01 2025-06-30
 *       → explicit date range
 *
 *   node scripts/backfill-marketing.mjs --dry-run
 *       → fetch + parse reports but do NOT write to DB
 *
 * Reads credentials from .env.local automatically.
 *
 * Required env vars:
 *   TURSO_DATABASE_URL        Turso libSQL URL
 *   TURSO_AUTH_TOKEN          Turso auth token
 *   AMAZON_VENDOR_CLIENT_ID       LWA client ID
 *   AMAZON_VENDOR_CLIENT_SECRET   LWA client secret
 *   AMAZON_VENDOR_REFRESH_TOKEN   Long-lived SP-API refresh token
 */

import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { createClient } from '@libsql/client';

// ---------------------------------------------------------------------------
// Load .env.local — ALWAYS overwrites so stale shell vars never win.
// Strips surrounding single/double quotes from values so KEY="val" works.
// ---------------------------------------------------------------------------
function loadEnvFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return; // file absent — caller must have vars in environment
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val   = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes: KEY="value" or KEY='value'
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Always set — file wins over stale shell exports
    process.env[key] = val;
  }
}

const envPath = new URL('../.env.local', import.meta.url).pathname;
loadEnvFile(envPath);

// Diagnostic: confirm the right vendor credentials were loaded
// (prints first 8 chars only — safe to show in logs)
console.log('  [env] AMAZON_VENDOR_CLIENT_ID     :', (process.env.AMAZON_VENDOR_CLIENT_ID     ?? '').slice(0, 8) + '…');
console.log('  [env] AMAZON_VENDOR_CLIENT_SECRET :', (process.env.AMAZON_VENDOR_CLIENT_SECRET ?? '').slice(0, 4) + '…');
console.log('  [env] AMAZON_VENDOR_REFRESH_TOKEN :', (process.env.AMAZON_VENDOR_REFRESH_TOKEN ?? '').slice(0, 8) + '…');
console.log();

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

const DRY_RUN  = args.includes('--dry-run');
const daysIdx  = args.indexOf('--days');
const DAYS     = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) || 90 : 90;

// Explicit date args override --days
const dateArgs    = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const RANGE_START = dateArgs[0] ?? null;
const RANGE_END   = dateArgs[1] ?? null;

// ---------------------------------------------------------------------------
// Validate env
// ---------------------------------------------------------------------------
const TURSO_URL   = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const LWA_CLIENT_ID     = process.env.AMAZON_VENDOR_CLIENT_ID;
const LWA_CLIENT_SECRET = process.env.AMAZON_VENDOR_CLIENT_SECRET;
const LWA_REFRESH_TOKEN = process.env.AMAZON_VENDOR_REFRESH_TOKEN;

const missing = [
  !TURSO_URL   && 'TURSO_DATABASE_URL',
  !TURSO_TOKEN && 'TURSO_AUTH_TOKEN',
  !LWA_CLIENT_ID     && 'AMAZON_VENDOR_CLIENT_ID',
  !LWA_CLIENT_SECRET && 'AMAZON_VENDOR_CLIENT_SECRET',
  !LWA_REFRESH_TOKEN && 'AMAZON_VENDOR_REFRESH_TOKEN',
].filter(Boolean);

if (missing.length) {
  console.error(`\n❌  Missing env vars: ${missing.join(', ')}`);
  console.error('    Set them in .env.local or export before running.\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function toYMD(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return toYMD(d);
}

/**
 * Slice [start, end] into at-most 30-day chunks.
 * Returns array of { start, end } pairs.
 */
function buildChunks(start, end, maxDays = 30) {
  const chunks = [];
  let cursor = start;
  while (cursor <= end) {
    const chunkEnd = addDays(cursor, maxDays - 1);
    chunks.push({ start: cursor, end: chunkEnd > end ? end : chunkEnd });
    cursor = addDays(chunkEnd, 1);
    if (cursor > end) break;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// LWA — get access token
// ---------------------------------------------------------------------------
let _cachedToken = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiry - 60_000) return _cachedToken;

  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: LWA_REFRESH_TOKEN,
      client_id:     LWA_CLIENT_ID,
      client_secret: LWA_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LWA token refresh failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  _cachedToken = json.access_token;
  _tokenExpiry = Date.now() + (json.expires_in ?? 3600) * 1000;
  return _cachedToken;
}

// ---------------------------------------------------------------------------
// SP-API helpers
// ---------------------------------------------------------------------------
const SP_API_BASE = 'https://sellingpartnerapi-na.amazon.com';

async function spApi(method, path, body) {
  const token = await getAccessToken();
  const res = await fetch(`${SP_API_BASE}${path}`, {
    method,
    headers: {
      'x-amz-access-token': token,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SP-API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function createReport(reportType, startDate, endDate, reportOptions = {}) {
  const payload = {
    reportType,
    reportOptions,
    dataStartTime: `${startDate}T00:00:00Z`,
    dataEndTime:   `${endDate}T23:59:59Z`,
    marketplaceIds: ['ATVPDKIKX0DER'],
  };
  console.log(`  → createReport: ${reportType} ${startDate}→${endDate}`);
  const data = await spApi('POST', '/reports/2021-06-30/reports', payload);
  if (!data.reportId) throw new Error('No reportId in createReport response');
  return data.reportId;
}

async function pollReport(reportId, maxAttempts = 50, intervalMs = 8_000) {
  const start = Date.now();
  for (let i = 0; i < maxAttempts; i++) {
    const data = await spApi('GET', `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`\r    poll ${i + 1}/${maxAttempts} status=${data.processingStatus} elapsed=${elapsed}s`);

    if (data.processingStatus === 'DONE') {
      process.stdout.write('\n');
      return data;
    }
    if (data.processingStatus === 'FATAL' || data.processingStatus === 'CANCELLED') {
      process.stdout.write('\n');

      // Try to fetch error document if present
      if (data.reportDocumentId) {
        try {
          const raw = await downloadDocument(data.reportDocumentId);
          console.error(`  Error document:\n${raw.slice(0, 500)}`);
        } catch { /* ignore */ }
      }
      throw new Error(`Report ${reportId} ended with status ${data.processingStatus}`);
    }
    if (i < maxAttempts - 1) {
      await sleep(intervalMs);
    }
  }
  process.stdout.write('\n');
  throw new Error(`Report ${reportId} timed out after ${maxAttempts} attempts`);
}

async function downloadDocument(documentId) {
  const meta = await spApi('GET', `/reports/2021-06-30/documents/${encodeURIComponent(documentId)}`);
  const fileRes = await fetch(meta.url);
  if (!fileRes.ok) throw new Error(`Download failed (${fileRes.status}): ${meta.url}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  return meta.compressionAlgorithm === 'GZIP'
    ? gunzipSync(buf).toString('utf-8')
    : buf.toString('utf-8');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseJsonAmountField(val) {
  if (val == null) return 0;
  if (typeof val === 'object' && 'amount' in val) return parseFloat(val.amount) || 0;
  return parseFloat(val) || 0;
}

function extractCurrency(val) {
  if (typeof val === 'object' && val !== null && 'currencyCode' in val) return val.currencyCode || 'USD';
  return 'USD';
}

function normalizeDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return s;
}

function extractCandidates(raw) {
  const trimmed = raw.trim();
  const candidates = [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      Array.isArray(parsed) ? candidates.push(...parsed) : candidates.push(parsed);
      return candidates;
    } catch { /* fall through */ }
  }
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try { candidates.push(JSON.parse(l)); } catch { /* skip */ }
  }
  return candidates;
}


function parsePromotions(raw) {
  const candidates = extractCandidates(raw);

  // JSON path
  const rows = [];
  for (const obj of candidates) {
    const arr = obj['promotionPerformanceByAsin'] ?? obj['promotions'];
    if (!Array.isArray(arr)) continue;
    for (const r of arr) {
      const asin         = String(r.asin ?? r.ASIN ?? '').trim();
      const promotion_id = String(r.promotionId ?? r.promotion_id ?? '').trim();
      if (!asin || !promotion_id) continue;
      rows.push({
        asin,
        promotion_id,
        promotion_name: String(r.promotionName ?? r.promotion_name ?? '').trim(),
        promotion_type: String(r.promotionType ?? r.promotion_type ?? '').trim(),
        report_date:    normalizeDate(r.startDate ?? r.date ?? ''),
        redemptions:    parseInt(r.redemptions ?? 0, 10) || 0,
        discount_amount: parseJsonAmountField(r.discountAmount ?? r.discount_amount),
        sales:           parseJsonAmountField(r.attributedSales ?? r.sales),
      });
    }
  }
  if (rows.length > 0) return rows;

  // TSV fallback
  const lines = raw.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map(h => h.trim().toLowerCase());
  const col = (...cs) => {
    for (const c of cs) {
      const idx = headers.findIndex(h => h.includes(c));
      if (idx !== -1) return idx;
    }
    return -1;
  };
  const dateIdx   = col('date', 'start date', 'promotion start');
  const asinIdx   = col('asin');
  const idIdx     = col('promotion id', 'promoid');
  const nameIdx   = col('promotion name');
  const typeIdx   = col('promotion type');
  const redIdx    = col('redemption');
  const discIdx   = col('discount amount', 'discount');
  const salesIdx  = col('attributed sales', 'sales');

  if (asinIdx === -1 || idIdx === -1) return [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const asin         = cols[asinIdx]?.trim();
    const promotion_id = cols[idIdx]?.trim();
    if (!asin || !promotion_id) continue;
    const rawDate = dateIdx !== -1 ? (cols[dateIdx]?.trim() ?? '') : '';
    const report_date = rawDate ? normalizeDate(rawDate) : '';
    if (!report_date) continue;
    rows.push({
      asin,
      promotion_id,
      promotion_name:  nameIdx !== -1 ? (cols[nameIdx]?.trim()  ?? '') : '',
      promotion_type:  typeIdx !== -1 ? (cols[typeIdx]?.trim()  ?? '') : '',
      report_date,
      redemptions:     redIdx  !== -1 ? parseInt(cols[redIdx]?.trim()  ?? '0', 10) || 0 : 0,
      discount_amount: discIdx !== -1 ? parseFloat((cols[discIdx]?.trim() ?? '0').replace(/[^0-9.-]/g, '')) || 0 : 0,
      sales:           salesIdx !== -1 ? parseFloat((cols[salesIdx]?.trim() ?? '0').replace(/[^0-9.-]/g, '')) || 0 : 0,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// DB upserts
// ---------------------------------------------------------------------------
const WRITE_BATCH = 100;

async function upsertPromotions(db, rows) {
  if (rows.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    const chunk = rows.slice(i, i + WRITE_BATCH);
    await db.batch(chunk.map(r => ({
      sql: `INSERT INTO asin_promotion_metrics
              (asin, promotion_id, report_date, promotion_name, promotion_type,
               redemptions, discount_amount, sales, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(asin, promotion_id, report_date) DO UPDATE SET
              promotion_name  = excluded.promotion_name,
              promotion_type  = excluded.promotion_type,
              redemptions     = excluded.redemptions,
              discount_amount = excluded.discount_amount,
              sales           = excluded.sales,
              updated_at      = datetime('now')`,
      args: [r.asin, r.promotion_id, r.report_date, r.promotion_name || null,
             r.promotion_type || null, r.redemptions, r.discount_amount, r.sales],
    })));
    count += chunk.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Per-chunk fetch logic (with retry on transient SP-API errors)
// ---------------------------------------------------------------------------

async function fetchAndInsert(db, reportType, chunkStart, chunkEnd, reportOptions, parser, upsertFn, chunkLabel) {
  let retries = 2;
  while (true) {
    try {
      const reportId = await createReport(reportType, chunkStart, chunkEnd, reportOptions);
      const status   = await pollReport(reportId);
      const raw      = await downloadDocument(status.reportDocumentId);
      const rows     = parser(raw);
      console.log(`    ✓ ${chunkLabel}: ${rows.length} rows parsed`);
      if (!DRY_RUN && rows.length > 0) {
        const n = await upsertFn(db, rows);
        console.log(`    ✓ ${chunkLabel}: ${n} rows upserted`);
        return n;
      }
      return rows.length;
    } catch (err) {
      const msg = String(err.message ?? err);

      // Access denied — skip permanently, no retry
      if (/403|access.?denied|not.*approved|unauthorized|insufficient.*access/i.test(msg)) {
        console.warn(`  ⚠  ${reportType} access denied — skipping all chunks. (${msg})`);
        return -1; // signal caller to stop this report type
      }

      if (retries > 0 && /429|throttl|quota|ServiceUnavailable|503/i.test(msg)) {
        retries--;
        console.warn(`  ⚠  throttled — waiting 30s before retry (${retries} left)`);
        await sleep(30_000);
        continue;
      }

      console.error(`  ✗ ${chunkLabel}: ${msg}`);
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  let rangeStart, rangeEnd;
  if (RANGE_START && RANGE_END) {
    rangeStart = RANGE_START;
    rangeEnd   = RANGE_END;
  } else {
    const today = new Date();
    rangeEnd   = toYMD(today);
    const s    = new Date(today);
    s.setDate(s.getDate() - (DAYS - 1));
    rangeStart = toYMD(s);
  }

  const chunks = buildChunks(rangeStart, rangeEnd, 30);

  console.log('\n🔄  Backfill Vendor promotion data');
  console.log(`    Report      : GET_PROMOTION_PERFORMANCE_REPORT`);
  console.log(`    Date range  : ${rangeStart} → ${rangeEnd}`);
  console.log(`    Chunks      : ${chunks.length} × up-to-30-day windows`);
  console.log(`    Mode        : ${DRY_RUN ? 'DRY RUN (no DB writes)' : 'LIVE'}`);
  console.log();

  const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

  let promotionsTotal = 0;

  // ── GET_PROMOTION_PERFORMANCE_REPORT ─────────────────────────────────────
  console.log('── GET_PROMOTION_PERFORMANCE_REPORT ─────────────────────────────');

  let accessDenied = false;
  for (let i = 0; i < chunks.length; i++) {
    if (accessDenied) break;
    const { start, end } = chunks[i];
    console.log(`\n  Chunk ${i + 1}/${chunks.length}: ${start} → ${end}`);
    const n = await fetchAndInsert(
      db,
      'GET_PROMOTION_PERFORMANCE_REPORT',
      start, end,
      {},
      parsePromotions,
      upsertPromotions,
      `promotions ${start}→${end}`
    );
    if (n === -1) { accessDenied = true; break; }
    promotionsTotal += n;

    if (i < chunks.length - 1) await sleep(5_000);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(65)}`);
  console.log(`✅  Done!`);
  console.log(`    asin_promotion_metrics rows : ${promotionsTotal.toLocaleString()}`);
  if (DRY_RUN) console.log(`    [DRY RUN — no writes performed]`);
  console.log();

  await db.close();
}

main().catch(err => {
  console.error('\n💥  Fatal:', err.message ?? err);
  process.exit(1);
});
