/**
 * Retry backfill for specific failed months.
 * Fetches one month at a time with aggressive retry on network errors.
 *
 * Usage:
 *   node scripts/backfill-retry.mjs
 */

import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

// Load .env.local
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

const TURSO_URL      = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN    = process.env.TURSO_AUTH_TOKEN;
const TEAPPLIX_TOKEN = process.env.TEAPPLIX_API_TOKEN;
const BASE           = 'https://api.teapplix.com/api2';

if (!TURSO_URL || !TURSO_TOKEN || !TEAPPLIX_TOKEN) {
  console.error('❌  Missing env vars: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, TEAPPLIX_API_TOKEN');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ---------------------------------------------------------------------------
// The 14 failed months — edit this list if you need to add/remove months
// ---------------------------------------------------------------------------
const FAILED_MONTHS = [
  { start: '2024-05-01', end: '2024-05-31' },
  { start: '2024-09-01', end: '2024-09-30' },
  { start: '2024-10-01', end: '2024-10-31' },
  { start: '2024-11-01', end: '2024-11-30' },
  { start: '2024-12-01', end: '2024-12-31' },
  { start: '2025-01-01', end: '2025-01-31' },
  { start: '2025-02-01', end: '2025-02-28' },
  { start: '2025-03-01', end: '2025-03-31' },
  { start: '2025-04-01', end: '2025-04-30' },
  { start: '2025-05-01', end: '2025-05-31' },
  { start: '2025-06-01', end: '2025-06-30' },
  { start: '2025-07-01', end: '2025-07-31' },
  { start: '2025-08-01', end: '2025-08-31' },
  { start: '2025-09-01', end: '2025-09-30' },
];

// ---------------------------------------------------------------------------
// Multi-pack normalization
// ---------------------------------------------------------------------------
const WORD_PACK_SUFFIXES = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, eight: 8, ten: 10, twelve: 12,
};

function normalizeMultiPack(sku, qty, totalPrice) {
  const numMatch = sku.match(/^(.+)-(\d+)$/);
  if (numMatch) {
    const multiplier = parseInt(numMatch[2], 10);
    if (multiplier >= 2) {
      const normalizedQty = qty * multiplier;
      return { sku: numMatch[1], qty: normalizedQty, unitPrice: totalPrice / normalizedQty, totalPrice };
    }
  }
  const wordMatch = sku.match(/^(.+)-([a-zA-Z]+)$/);
  if (wordMatch) {
    const word = wordMatch[2].toLowerCase();
    if (word in WORD_PACK_SUFFIXES) {
      const multiplier = WORD_PACK_SUFFIXES[word];
      const normalizedQty = qty * multiplier;
      return { sku: wordMatch[1], qty: normalizedQty, unitPrice: totalPrice / normalizedQty, totalPrice };
    }
  }
  return { sku, qty, unitPrice: qty > 0 ? totalPrice / qty : 0, totalPrice };
}

// ---------------------------------------------------------------------------
// Fetch with retry — up to 7 attempts, exponential backoff up to 30s
// ---------------------------------------------------------------------------
async function fetchWithRetry(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: { APIToken: TEAPPLIX_TOKEN },
      signal: AbortSignal.timeout(60000), // 60s per request
    });
    if ((res.status === 503 || res.status === 429) && attempt <= 7) {
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
      console.warn(`    ⚠  HTTP ${res.status} — retrying in ${delay / 1000}s (attempt ${attempt}/7)...`);
      await sleep(delay);
      return fetchWithRetry(url, attempt + 1);
    }
    return res;
  } catch (err) {
    if (attempt <= 7) {
      const delay = Math.min(3000 * Math.pow(2, attempt - 1), 30000);
      console.warn(`    ⚠  Network error (${err.message}) — retrying in ${delay / 1000}s (attempt ${attempt}/7)...`);
      await sleep(delay);
      return fetchWithRetry(url, attempt + 1);
    }
    throw err;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Fetch all orders for a month (with pagination)
// ---------------------------------------------------------------------------
async function fetchOrdersForRange(startDate, endDate) {
  const allOrders = [];
  let seqStart = null;
  let page = 1;

  while (true) {
    const url = new URL(`${BASE}/OrderNotification`);
    url.searchParams.set('PaymentDateStart', startDate);
    url.searchParams.set('PaymentDateEnd', endDate);
    if (seqStart !== null) url.searchParams.set('SeqStart', String(seqStart));

    const res = await fetchWithRetry(url.toString());
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Teapplix ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const orders = data.Orders ?? [];
    allOrders.push(...orders);

    const p = data.Pagination;
    if (p && p.PageNumber < p.TotalPages) {
      seqStart = parseInt(orders[orders.length - 1].SeqNumber, 10) + 1;
      page++;
      process.stdout.write(` [p${page}]`);
    } else {
      break;
    }
  }

  return allOrders;
}

// ---------------------------------------------------------------------------
// Upsert rows to Turso in batches
// ---------------------------------------------------------------------------
async function upsertRows(rows) {
  if (rows.length === 0) return;
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT OR REPLACE INTO orders
                (order_id, order_date, sku, qty, unit_price, total_price)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [r.order_id, r.order_date, r.sku, r.qty, r.unit_price, r.total_price],
      }))
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n🔄  Retrying ${FAILED_MONTHS.length} failed months`);
  console.log(`    DB: ${TURSO_URL}\n`);

  const before = await db.execute('SELECT COUNT(*) as cnt FROM orders');
  console.log(`    Orders in DB before: ${before.rows[0].cnt}\n`);

  let totalOrders = 0;
  let totalRows   = 0;
  const stillFailing = [];

  for (const { start, end } of FAILED_MONTHS) {
    process.stdout.write(`  ${start} → ${end} ... `);

    try {
      const orders = await fetchOrdersForRange(start, end);
      const rows = [];

      for (const order of orders) {
        const paymentDate = order.OrderDetails?.PaymentDate?.slice(0, 10);
        if (!paymentDate) continue;

        for (const item of (order.OrderItems ?? [])) {
          const rawSku = (item.ItemId || item.Name || '').trim();
          if (!rawSku) continue;

          const qty        = Number(item.Quantity) || 0;
          const totalPrice = Number(item.Amount)   || 0;
          if (qty <= 0) continue;

          const n = normalizeMultiPack(rawSku, qty, totalPrice);
          rows.push({
            order_id   : `${order.TxnId}|${n.sku}`,
            order_date : paymentDate,
            sku        : n.sku,
            qty        : n.qty,
            unit_price : Math.round(n.unitPrice * 100) / 100,
            total_price: Math.round(n.totalPrice * 100) / 100,
          });
        }
      }

      await upsertRows(rows);
      totalOrders += orders.length;
      totalRows   += rows.length;
      console.log(` ✓  ${orders.length} orders → ${rows.length} rows`);
    } catch (err) {
      console.log(` ✗  FAILED: ${err.message}`);
      stillFailing.push({ month: start, error: err.message });
    }

    // Pause between months to be polite to the API
    await sleep(1000);
  }

  const after = await db.execute('SELECT COUNT(*) as cnt FROM orders');
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`✅  Done!`);
  console.log(`    Orders fetched : ${totalOrders.toLocaleString()}`);
  console.log(`    Rows upserted  : ${totalRows.toLocaleString()}`);
  console.log(`    Orders in DB   : ${after.rows[0].cnt}`);

  if (stillFailing.length > 0) {
    console.log(`\n⚠   ${stillFailing.length} month(s) still failing — run the script again:`);
    for (const { month, error } of stillFailing) {
      console.log(`    ${month}: ${error}`);
    }
    console.log(`\n    Command: node scripts/backfill-retry.mjs`);
  } else {
    console.log(`\n🎉  All months synced successfully!`);
    console.log(`\n    Next step — run the allocation backfill to populate the restock planner:`);
    console.log(`    node scripts/backfill-allocations.mjs 2024-05-01 2025-09-30`);
  }
}

main().catch((err) => {
  console.error('\n💥  Fatal:', err.message);
  process.exit(1);
});
