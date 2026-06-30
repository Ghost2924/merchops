/**
 * Backfill ARA (Vendor Central) data for up to 1 year.
 *
 * SP-API ARA DAY reports are capped at 15 days per request.
 * This script slices the target range into 14-day windows and runs
 * each one sequentially: Sales → Margin → Inventory, then moves on.
 *
 * Usage:
 *   node scripts/backfill-vendor-ara.mjs                          # last 365 days
 *   node scripts/backfill-vendor-ara.mjs 2025-01-01 2025-12-31   # custom range
 *   node scripts/backfill-vendor-ara.mjs 2025-06-01               # start → today
 *
 * Each window takes ~2–3 min (3 reports × poll time).
 * Full year ≈ 26 windows ≈ ~60–80 min total.
 *
 * Reads credentials from .env.local automatically.
 * All upserts are idempotent — safe to re-run / resume from any point.
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
  const val = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = val;
}

// ---------------------------------------------------------------------------
// Config / validation
// ---------------------------------------------------------------------------
const TURSO_URL    = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN  = process.env.TURSO_AUTH_TOKEN;
const CLIENT_ID    = process.env.AMAZON_VENDOR_CLIENT_ID;
const CLIENT_SEC   = process.env.AMAZON_VENDOR_CLIENT_SECRET;
const REFRESH_TOK  = process.env.AMAZON_VENDOR_REFRESH_TOKEN;
const SP_API_BASE  = 'https://sellingpartnerapi-na.amazon.com';

const missing = ['TURSO_DATABASE_URL','TURSO_AUTH_TOKEN','AMAZON_VENDOR_CLIENT_ID','AMAZON_VENDOR_CLIENT_SECRET','AMAZON_VENDOR_REFRESH_TOKEN']
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.error('❌  Missing env vars:', missing.join(', '));
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ---------------------------------------------------------------------------
// CLI args: [startDate] [endDate]  (YYYY-MM-DD)
// ---------------------------------------------------------------------------
function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const argStart = process.argv[2];
const argEnd   = process.argv[3];

// ARA lags ~4 days — never request data newer than 4 days ago
const SAFE_END = daysAgo(4);

let rangeStart = argStart ?? daysAgo(365);
let rangeEnd   = argEnd   ?? SAFE_END;

// Clamp end to safe boundary
if (rangeEnd > SAFE_END) {
  console.warn(`⚠   End date ${rangeEnd} clamped to ${SAFE_END} (ARA ~4-day lag)`);
  rangeEnd = SAFE_END;
}

if (rangeStart >= rangeEnd) {
  console.error(`❌  Start (${rangeStart}) must be before end (${rangeEnd})`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Slice range into 14-day windows  (SP-API DAY cap = 15 days)
// ---------------------------------------------------------------------------
function buildWindows(start, end) {
  const windows = [];
  let cursor = start;
  while (cursor < end) {
    const windowEnd = new Date(cursor);
    windowEnd.setDate(windowEnd.getDate() + 13); // +13 = 14 days inclusive
    const windowEndStr = windowEnd.toISOString().slice(0, 10);
    windows.push({
      start: cursor,
      end: windowEndStr < end ? windowEndStr : end,
    });
    // Advance to day after this window
    const next = new Date(windowEndStr);
    next.setDate(next.getDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }
  return windows;
}

// ---------------------------------------------------------------------------
// LWA token (reuse within script lifetime, refresh when needed)
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
    throw new Error(`SP-API ${method} ${path} (${res.status}): ${text.slice(0, 400)}`);
  }
  return res.json();
}

async function createReport(reportType, reportOptions, dataStart, dataEnd) {
  const data = await spApi('POST', '/reports/2021-06-30/reports', {
    reportType,
    reportOptions,
    dataStartTime: dataStart,
    dataEndTime:   dataEnd,
    marketplaceIds: ['ATVPDKIKX0DER'],
  });
  return data.reportId;
}

async function pollUntilDone(reportId, maxAttempts = 60, intervalMs = 6_000) {
  for (let i = 0; i < maxAttempts; i++) {
    const data = await spApi('GET', `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`);
    const status = data.processingStatus;
    process.stdout.write(` ${status}`);

    if (status === 'DONE')      return data.reportDocumentId;
    if (status === 'FATAL' || status === 'CANCELLED') {
      throw new Error(`Report ${reportId} ended with ${status}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`Report ${reportId} timed out after ${maxAttempts} polls`);
}

async function downloadDocument(docId) {
  const meta = await spApi('GET', `/reports/2021-06-30/documents/${encodeURIComponent(docId)}`);
  const res  = await fetch(meta.url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for doc ${docId}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return meta.compressionAlgorithm === 'GZIP'
    ? gunzipSync(buf).toString('utf-8')
    : buf.toString('utf-8');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Report parsers  (mirrors lib/sync/runVendorSync.ts)
// ---------------------------------------------------------------------------
function extractAmount(val) {
  if (val == null) return null;
  if (typeof val === 'object' && 'amount' in val) return Number(val.amount) || null;
  const n = Number(val);
  return isFinite(n) ? n : null;
}

function extractInt(val) {
  const n = Number(val);
  return isFinite(n) ? Math.round(n) : null;
}

function extractCurrency(val) {
  if (typeof val === 'object' && val && 'currencyCode' in val) return val.currencyCode || 'USD';
  return 'USD';
}

function parseNdjson(raw, arrayKey) {
  const trimmed = raw.trim();
  const candidates = [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const p = JSON.parse(trimmed);
      Array.isArray(p) ? candidates.push(...p) : candidates.push(p);
    } catch { /* fall through */ }
  }
  if (!candidates.length) {
    for (const line of trimmed.split('\n')) {
      try { if (line.trim()) candidates.push(JSON.parse(line.trim())); } catch { /* skip */ }
    }
  }
  const rows = [];
  for (const obj of candidates) {
    if (Array.isArray(obj[arrayKey])) rows.push(...obj[arrayKey]);
  }
  return rows;
}

function parseSales(raw) {
  return parseNdjson(raw, 'salesByAsin')
    .filter((r) => r.asin || r.ASIN)
    .map((r) => ({
      asin:             String(r.asin ?? r.ASIN),
      period_start:     String(r.startDate ?? r.dataStartTime ?? ''),
      period_end:       String(r.endDate   ?? r.dataEndTime   ?? ''),
      period_type:      'DAY',
      shipped_revenue:  extractAmount(r.shippedRevenue),
      shipped_cogs:     extractAmount(r.shippedCogs),
      ordered_units:    extractInt(r.orderedUnits),
      shipped_units:    extractInt(r.shippedUnits),
      customer_returns: extractInt(r.customerReturns),
      net_ppm:          null,
      sales_discount:   null,
      currency:         extractCurrency(r.shippedRevenue) || 'USD',
    }));
}

function parseMargin(raw) {
  return parseNdjson(raw, 'netPureProductMarginByAsin')
    .filter((r) => r.asin || r.ASIN)
    .map((r) => {
      const rawPpm = extractAmount(r.netPureProductMargin ?? r.netPpm ?? r.netPPM);
      return {
        asin:           String(r.asin ?? r.ASIN),
        period_start:   String(r.startDate ?? r.dataStartTime ?? ''),
        period_end:     String(r.endDate   ?? r.dataEndTime   ?? ''),
        period_type:    'DAY',
        shipped_revenue: null,
        shipped_cogs:    null,
        ordered_units:   null,
        shipped_units:   null,
        customer_returns: null,
        net_ppm:         rawPpm != null ? rawPpm * 100 : null,
        sales_discount:  extractAmount(r.salesDiscount),
        currency:        'USD',
      };
    });
}

function parseInventory(raw) {
  return parseNdjson(raw, 'inventoryByAsin')
    .filter((r) => r.asin || r.ASIN)
    .map((r) => ({
      asin:                            String(r.asin ?? r.ASIN),
      snapshot_date:                   String(r.snapshotDate ?? r.startDate ?? r.dataStartTime ?? ''),
      roos_percent:                    extractAmount(r.sourceableProductOutOfStockRate ?? r.procurableProductOutOfStockRate),
      sellable_on_hand_units:          extractInt(r.sellableOnHandInventoryUnits ?? r.sellableOnHandUnits),
      open_po_units:                   extractInt(r.openPurchaseOrderUnits ?? r.openPoUnits),
      unfilled_customer_ordered_units: extractInt(r.unfilledCustomerOrderedUnits),
    }));
}

// ---------------------------------------------------------------------------
// DB upserts
// ---------------------------------------------------------------------------
async function upsertAra(rows) {
  if (!rows.length) return 0;
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.batch(rows.slice(i, i + BATCH).map((r) => ({
      sql: `INSERT INTO vendor_ara_metrics
              (asin, period_start, period_end, period_type,
               shipped_revenue, shipped_cogs, ordered_units, shipped_units, customer_returns,
               net_ppm, sales_discount, currency, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(asin, period_start, period_end, period_type) DO UPDATE SET
              shipped_revenue  = COALESCE(excluded.shipped_revenue,  shipped_revenue),
              shipped_cogs     = COALESCE(excluded.shipped_cogs,     shipped_cogs),
              ordered_units    = COALESCE(excluded.ordered_units,    ordered_units),
              shipped_units    = COALESCE(excluded.shipped_units,    shipped_units),
              customer_returns = COALESCE(excluded.customer_returns, customer_returns),
              net_ppm          = COALESCE(excluded.net_ppm,          net_ppm),
              sales_discount   = COALESCE(excluded.sales_discount,   sales_discount),
              currency         = excluded.currency,
              updated_at       = datetime('now')`,
      args: [
        r.asin, r.period_start, r.period_end, r.period_type,
        r.shipped_revenue, r.shipped_cogs, r.ordered_units,
        r.shipped_units, r.customer_returns, r.net_ppm, r.sales_discount, r.currency,
      ],
    })));
  }
  return rows.length;
}

async function upsertInventory(rows) {
  if (!rows.length) return 0;
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.batch(rows.slice(i, i + BATCH).map((r) => ({
      sql: `INSERT INTO vendor_inventory_health
              (asin, snapshot_date, roos_percent,
               sellable_on_hand_units, open_po_units, unfilled_customer_ordered_units,
               updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(asin, snapshot_date) DO UPDATE SET
              roos_percent                    = COALESCE(excluded.roos_percent,                    roos_percent),
              sellable_on_hand_units          = COALESCE(excluded.sellable_on_hand_units,          sellable_on_hand_units),
              open_po_units                   = COALESCE(excluded.open_po_units,                   open_po_units),
              unfilled_customer_ordered_units = COALESCE(excluded.unfilled_customer_ordered_units, unfilled_customer_ordered_units),
              updated_at                      = datetime('now')`,
      args: [
        r.asin, r.snapshot_date, r.roos_percent,
        r.sellable_on_hand_units, r.open_po_units, r.unfilled_customer_ordered_units,
      ],
    })));
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Run one report for a window
// ---------------------------------------------------------------------------
async function runReport(reportType, options, start, end, label) {
  process.stdout.write(`      ${label} ... requesting`);
  try {
    const reportId = await createReport(reportType, options, start, end);
    process.stdout.write(` [${reportId.slice(-8)}] polling`);
    const docId = await pollUntilDone(reportId);
    process.stdout.write(` downloading`);
    const raw = await downloadDocument(docId);
    return { ok: true, raw };
  } catch (err) {
    const msg = err.message;
    const accessDenied = /403|access.?denied|not.*approved|unauthorized/i.test(msg);
    if (accessDenied) {
      process.stdout.write(` ACCESS_DENIED (skipped)\n`);
      return { ok: false, skipped: true, error: msg };
    }
    process.stdout.write(` ERROR\n`);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const windows = buildWindows(rangeStart, rangeEnd);

  console.log('\n📊  ARA Vendor Central Backfill');
  console.log(`    Range   : ${rangeStart} → ${rangeEnd}`);
  console.log(`    Windows : ${windows.length} × 14-day chunks`);
  console.log(`    DB      : ${TURSO_URL}`);
  console.log(`    Est. time: ~${Math.ceil(windows.length * 2.5)} min\n`);

  // Check rows before
  const before = await db.execute('SELECT COUNT(*) as cnt FROM vendor_ara_metrics');
  console.log(`    ARA rows in DB before: ${before.rows[0].cnt}\n`);

  let totalAra  = 0;
  let totalInv  = 0;
  let errorWindows = [];

  for (let i = 0; i < windows.length; i++) {
    const { start, end } = windows[i];
    console.log(`\n  [${i + 1}/${windows.length}] ${start} → ${end}`);

    try {
      // ── Sales ──────────────────────────────────────────────────────────
      const sales = await runReport(
        'GET_VENDOR_SALES_REPORT',
        { distributorView: 'MANUFACTURING', sellingProgram: 'RETAIL', reportPeriod: 'DAY' },
        start, end, 'Sales'
      );
      if (sales.ok) {
        const rows = parseSales(sales.raw);
        const n = await upsertAra(rows);
        totalAra += n;
        console.log(` ✓  ${rows.length} rows`);
      }

      // ── Margin ─────────────────────────────────────────────────────────
      const margin = await runReport(
        'GET_VENDOR_NET_PURE_PRODUCT_MARGIN_REPORT',
        { reportPeriod: 'DAY' },
        start, end, 'Margin'
      );
      if (margin.ok) {
        const rows = parseMargin(margin.raw);
        const n = await upsertAra(rows);
        totalAra += n;
        console.log(` ✓  ${rows.length} rows`);
      }

      // ── Inventory ──────────────────────────────────────────────────────
      const inv = await runReport(
        'GET_VENDOR_INVENTORY_REPORT',
        { distributorView: 'SOURCING', sellingProgram: 'RETAIL', reportPeriod: 'DAY' },
        start, end, 'Inventory'
      );
      if (inv.ok) {
        const rows = parseInventory(inv.raw);
        const n = await upsertInventory(rows);
        totalInv += n;
        console.log(` ✓  ${rows.length} rows`);
      }

    } catch (err) {
      console.log(`\n    ✗  window failed: ${err.message}`);
      errorWindows.push({ window: `${start}→${end}`, error: err.message });
    }

    // Polite delay between windows — avoid SP-API throttling
    if (i < windows.length - 1) {
      process.stdout.write('    ⏳  waiting 8s...\n');
      await sleep(8_000);
    }
  }

  // Summary
  const after = await db.execute('SELECT COUNT(*) as cnt FROM vendor_ara_metrics');
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`✅  Done`);
  console.log(`    ARA rows upserted  : ${totalAra.toLocaleString()}`);
  console.log(`    Inv rows upserted  : ${totalInv.toLocaleString()}`);
  console.log(`    ARA rows in DB now : ${after.rows[0].cnt}`);

  if (errorWindows.length) {
    console.log(`\n⚠   ${errorWindows.length} window(s) failed — re-run with those dates to retry:`);
    for (const { window, error } of errorWindows) {
      console.log(`    ${window}: ${error}`);
    }
  }
}

main().catch((err) => {
  console.error('\n💥  Fatal:', err.message);
  process.exit(1);
});
