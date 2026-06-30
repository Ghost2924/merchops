/**
 * Historical backfill script: syncs a full date range from Teapplix → Turso.
 * Fetches month-by-month (one API call per month) to avoid rate limits.
 *
 * Usage:
 *   node scripts/backfill-historical.mjs [startYear] [endYear]
 *
 * Examples:
 *   node scripts/backfill-historical.mjs            # defaults: 2022 → today
 *   node scripts/backfill-historical.mjs 2022 2023  # only 2022–2023
 *   node scripts/backfill-historical.mjs 2023       # 2023 → today
 *
 * Reads credentials from .env.local automatically.
 */

import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

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
// Config
// ---------------------------------------------------------------------------
const TURSO_URL     = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN   = process.env.TURSO_AUTH_TOKEN;
const TEAPPLIX_TOKEN = process.env.TEAPPLIX_API_TOKEN;
const TZ            = process.env.BUSINESS_TIMEZONE ?? 'America/Los_Angeles';
const BASE          = 'https://api.teapplix.com/api2';

if (!TURSO_URL || !TURSO_TOKEN || !TEAPPLIX_TOKEN) {
  console.error('❌  Missing env vars: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, TEAPPLIX_API_TOKEN');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ---------------------------------------------------------------------------
// Date range from CLI args
// ---------------------------------------------------------------------------
const startYear = parseInt(process.argv[2] ?? '2022', 10);
const endYear   = parseInt(process.argv[3] ?? String(new Date().getFullYear()), 10);

if (isNaN(startYear) || isNaN(endYear) || startYear > endYear) {
  console.error('❌  Invalid year range. Usage: node backfill-historical.mjs [startYear] [endYear]');
  process.exit(1);
}

// Today in business timezone
const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

// ---------------------------------------------------------------------------
// Build list of months to sync: [{start: "YYYY-MM-DD", end: "YYYY-MM-DD"}]
// ---------------------------------------------------------------------------
function buildMonths(startYear, endYear) {
  const months = [];
  for (let year = startYear; year <= endYear; year++) {
    const maxMonth = year === endYear ? new Date().getMonth() + 1 : 12;
    for (let month = 1; month <= maxMonth; month++) {
      const start = `${year}-${String(month).padStart(2, '0')}-01`;
      // Last day of month
      const lastDay = new Date(year, month, 0).getDate();
      let end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      // Don't go past today
      if (end > todayStr) end = todayStr;
      if (start > todayStr) break;
      months.push({ start, end });
    }
  }
  return months;
}

// ---------------------------------------------------------------------------
// Multi-pack normalization (mirrors lib/teapplix/parser.ts)
// ---------------------------------------------------------------------------
const WORD_PACK_SUFFIXES = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, eight: 8, ten: 10, twelve: 12,
};

function parseMultiPackSku(sku) {
  const numMatch = sku.match(/^(.+)-(\d+)$/);
  if (numMatch) {
    const multiplier = parseInt(numMatch[2], 10);
    if (multiplier >= 2) return { baseSku: numMatch[1], multiplier };
  }
  const wordMatch = sku.match(/^(.+)-([a-zA-Z]+)$/);
  if (wordMatch) {
    const word = wordMatch[2].toLowerCase();
    if (word in WORD_PACK_SUFFIXES) {
      return { baseSku: wordMatch[1], multiplier: WORD_PACK_SUFFIXES[word] };
    }
  }
  return { baseSku: sku, multiplier: 1 };
}

function normalizeMultiPack(sku, qty, totalPrice) {
  const { baseSku, multiplier } = parseMultiPackSku(sku);
  const normalizedQty = qty * multiplier;
  const unitPrice = normalizedQty > 0 ? totalPrice / normalizedQty : 0;
  return {
    sku: baseSku,
    qty: normalizedQty,
    unitPrice: Math.round(unitPrice * 100) / 100,
    totalPrice: Math.round(totalPrice * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Teapplix fetch with retry + pagination
// ---------------------------------------------------------------------------
async function fetchWithRetry(url, attempt = 1) {
  const res = await fetch(url, { headers: { APIToken: TEAPPLIX_TOKEN } });
  if ((res.status === 503 || res.status === 429) && attempt < 5) {
    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
    console.warn(`    ⚠  ${res.status} — retrying in ${delay}ms (attempt ${attempt}/5)...`);
    await new Promise((r) => setTimeout(r, delay));
    return fetchWithRetry(url, attempt + 1);
  }
  return res;
}

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
      process.stdout.write(` [page ${page}]`);
    } else {
      break;
    }
  }

  return allOrders;
}

// ---------------------------------------------------------------------------
// Upsert to Turso
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
  const months = buildMonths(startYear, endYear);

  console.log(`\n📦  Teapplix → Turso historical backfill`);
  console.log(`    Range : ${months[0].start} → ${months[months.length - 1].end}`);
  console.log(`    Months: ${months.length}`);
  console.log(`    DB    : ${TURSO_URL}\n`);

  // Check existing row count
  const before = await db.execute('SELECT COUNT(*) as cnt FROM orders');
  console.log(`    Orders in DB before: ${before.rows[0].cnt}\n`);

  let totalOrders = 0;
  let totalRows   = 0;
  let errorMonths = [];

  for (const { start, end } of months) {
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
            unit_price : n.unitPrice,
            total_price: n.totalPrice,
          });
        }
      }

      await upsertRows(rows);
      totalOrders += orders.length;
      totalRows   += rows.length;
      console.log(`✓  ${orders.length} orders → ${rows.length} rows`);
    } catch (err) {
      console.log(`✗  ERROR: ${err.message}`);
      errorMonths.push({ month: start, error: err.message });
    }

    // Polite delay between months to avoid rate limiting
    await new Promise((r) => setTimeout(r, 500));
  }

  // Final summary
  const after = await db.execute('SELECT COUNT(*) as cnt FROM orders');
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`✅  Done!`);
  console.log(`    Orders fetched : ${totalOrders.toLocaleString()}`);
  console.log(`    Rows upserted  : ${totalRows.toLocaleString()}`);
  console.log(`    Orders in DB   : ${after.rows[0].cnt}`);

  if (errorMonths.length > 0) {
    console.log(`\n⚠   ${errorMonths.length} month(s) had errors — re-run to retry:`);
    for (const { month, error } of errorMonths) {
      console.log(`    ${month}: ${error}`);
    }
  }
}

main().catch((err) => {
  console.error('\n💥  Fatal:', err.message);
  process.exit(1);
});
