/**
 * debug-am5234.mjs — inspect what's actually stored for AM5234 variants
 */
import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env.local');
const lines = readFileSync(envPath, 'utf8').split('\n');
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
  if (!process.env[key]) process.env[key] = val;
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// 1. What's in order_lines for AM5234?
console.log('\n=== order_lines: AM5234 variants ===');
const ol = await db.execute(
  `SELECT order_line_id, raw_storefront_sku, resolved_teapplix_sku, qty_sold, revenue, order_date
   FROM order_lines
   WHERE raw_storefront_sku LIKE '%AM5234%'
      OR resolved_teapplix_sku LIKE '%AM5234%'
   ORDER BY order_date DESC LIMIT 50`
);
console.table(ol.rows.map(r => ({
  order_line_id: r.order_line_id,
  raw_storefront_sku: r.raw_storefront_sku,
  resolved_teapplix_sku: r.resolved_teapplix_sku,
  qty_sold: r.qty_sold,
  revenue: r.revenue,
  order_date: r.order_date,
})));

// 2. What does the dashboard actually query for this SKU?
console.log('\n=== SUM qty_sold grouped by resolved/raw sku ===');
const sums = await db.execute(
  `SELECT COALESCE(resolved_teapplix_sku, raw_storefront_sku) AS sku,
          raw_storefront_sku,
          SUM(qty_sold) AS total_qty,
          SUM(revenue) AS total_rev,
          COUNT(*) AS row_count
   FROM order_lines
   WHERE raw_storefront_sku LIKE '%AM5234%'
      OR resolved_teapplix_sku LIKE '%AM5234%'
   GROUP BY COALESCE(resolved_teapplix_sku, raw_storefront_sku), raw_storefront_sku
   ORDER BY sku`
);
console.table(sums.rows);

// 3. Check inventory_allocations
console.log('\n=== inventory_allocations for AM5234 ===');
const ia = await db.execute(
  `SELECT ia.inventory_sku, ia.source_storefront_sku, ia.qty_depleted, ia.allocation_type, ol.order_date
   FROM inventory_allocations ia
   JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
   WHERE ia.inventory_sku LIKE '%AM5234%'
      OR ia.source_storefront_sku LIKE '%AM5234%'
   ORDER BY ol.order_date DESC LIMIT 30`
);
console.table(ia.rows);

// 4. Scan for ANY word-suffix SKUs in order_lines
console.log('\n=== Any word-suffix raw_storefront_sku in order_lines (sample) ===');
const words = ['one','two','three','four','five','six','seven','eight','nine','ten','twelve','fifteen','twenty'];
const like = words.map(w => `raw_storefront_sku LIKE '%-${w}'`).join(' OR ');
const wordRows = await db.execute(
  `SELECT raw_storefront_sku, resolved_teapplix_sku, qty_sold, order_date
   FROM order_lines WHERE ${like} LIMIT 20`
);
console.log(`Found ${wordRows.rows.length} rows with word-suffix SKUs`);
console.table(wordRows.rows);

process.exit(0);
