/**
 * Checks for duplicate rows in the orders table.
 * Duplicates = same (order_id, sku) appearing more than once,
 * OR same (order_date, sku, qty, total_price) from different order_ids.
 *
 * Usage: node scripts/check-duplicates.mjs
 */

import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

// Load .env.local
const envPath = new URL('../.env.local', import.meta.url).pathname;
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = val;
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  // 1. Total row count
  const total = await db.execute('SELECT COUNT(*) as cnt FROM orders');
  console.log(`\nTotal rows in orders table: ${total.rows[0].cnt}`);

  // 2. Check for duplicate (order_id, sku) — should be 0 due to UNIQUE INDEX
  const dupIndex = await db.execute(`
    SELECT order_id, sku, COUNT(*) as cnt
    FROM orders
    GROUP BY order_id, sku
    HAVING cnt > 1
    LIMIT 20
  `);
  console.log(`\nDuplicate (order_id, sku) pairs: ${dupIndex.rows.length}`);
  if (dupIndex.rows.length > 0) {
    console.table(dupIndex.rows);
  }

  // 3. Check for same transaction appearing under different order_id formats
  //    (e.g. "TxnId|sku" vs just "TxnId") — look for same date+sku+qty+price
  const dupContent = await db.execute(`
    SELECT order_date, sku, qty, total_price, COUNT(*) as cnt, GROUP_CONCAT(order_id) as ids
    FROM orders
    GROUP BY order_date, sku, qty, total_price
    HAVING cnt > 1
    ORDER BY cnt DESC
    LIMIT 20
  `);
  console.log(`\nRows with same (date, sku, qty, price) but different order_ids: ${dupContent.rows.length}`);
  if (dupContent.rows.length > 0) {
    console.log('Top duplicates:');
    for (const r of dupContent.rows) {
      console.log(`  ${r.order_date} | ${r.sku} | qty=${r.qty} | $${r.total_price} | count=${r.cnt}`);
      console.log(`    order_ids: ${String(r.ids).slice(0, 120)}`);
    }
  }

  // 4. Row counts by year
  const byYear = await db.execute(`
    SELECT SUBSTR(order_date, 1, 4) as year, COUNT(*) as rows, COUNT(DISTINCT order_id) as orders
    FROM orders
    GROUP BY year
    ORDER BY year
  `);
  console.log('\nRows by year:');
  console.table(byYear.rows.map(r => ({ year: r.year, rows: r.rows, orders: r.orders })));
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
