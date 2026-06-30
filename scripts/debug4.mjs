/**
 * Find all "bare" SKUs in order_lines that:
 * - Have mapping_status = 'mapped', product_type = 'inventory'
 * - But their resolved_teapplix_sku does NOT exist in inventory_products
 * - AND a -1 variant of that SKU DOES exist in inventory_products
 *
 * These are the ghost SKUs where bare = pack-of-1 variant.
 */
import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envLines = readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n');
for (const l of envLines) { const m = l.match(/^([^#=]+)=(.*)/); if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, ''); }

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// All resolved SKUs in order_lines that are 'inventory' type but missing from inventory_products
const ghostResult = await db.execute(`
  SELECT ol.resolved_teapplix_sku AS sku,
         SUM(ol.qty_sold)         AS total_qty,
         COUNT(*)                 AS order_lines,
         MIN(ol.order_date)       AS first_seen,
         MAX(ol.order_date)       AS last_seen
  FROM order_lines ol
  WHERE ol.mapping_status = 'mapped'
    AND ol.resolved_product_type = 'inventory'
    AND ol.resolved_teapplix_sku NOT IN (SELECT sku FROM inventory_products)
  GROUP BY ol.resolved_teapplix_sku
  ORDER BY total_qty DESC
`);

console.log(`Ghost SKUs (mapped+inventory but not in inventory_products): ${ghostResult.rows.length}\n`);

let fixable = 0;
let notFixable = 0;

for (const r of ghostResult.rows) {
  const sku = r.sku;
  // Check if sku + '-1' exists in inventory_products
  const candidate1 = `${sku}-1`;
  const check = await db.execute({
    sql: `SELECT sku FROM inventory_products WHERE sku = ? OR sku = ?`,
    args: [candidate1, sku.replace(/^AM(?=\d)/, '') + '-1']
  });
  const found = check.rows.map(r => r.sku);
  const fixLabel = found.length > 0 ? `→ FIX: remap to ${found.join(' or ')}` : '→ NO -1 VARIANT FOUND';
  if (found.length > 0) fixable++;
  else notFixable++;
  console.log(`  ${sku}: ${r.total_qty} units, ${r.order_lines} lines (${r.first_seen} → ${r.last_seen}) ${fixLabel}`);
}

console.log(`\nFixable (has -1 variant): ${fixable}`);
console.log(`Not fixable (no -1 variant): ${notFixable}`);

// Also check total qty impact of ghost SKUs in LY months
const impactResult = await db.execute(`
  SELECT 
    SUM(CASE WHEN order_date >= '2025-06-01' AND order_date <= '2025-06-30' THEN qty_sold ELSE 0 END) AS jun_2025,
    SUM(CASE WHEN order_date >= '2025-05-01' AND order_date <= '2025-05-31' THEN qty_sold ELSE 0 END) AS may_2025,
    SUM(CASE WHEN order_date >= '2025-04-01' AND order_date <= '2025-04-30' THEN qty_sold ELSE 0 END) AS apr_2025,
    SUM(qty_sold) AS all_time
  FROM order_lines
  WHERE mapping_status = 'mapped'
    AND resolved_product_type = 'inventory'
    AND resolved_teapplix_sku NOT IN (SELECT sku FROM inventory_products)
`);
const imp = impactResult.rows[0];
console.log(`\nTotal ghost-SKU qty impact:`);
console.log(`  Jun 2025: ${imp.jun_2025} units hidden`);
console.log(`  May 2025: ${imp.may_2025} units hidden`);
console.log(`  Apr 2025: ${imp.apr_2025} units hidden`);
console.log(`  All time: ${imp.all_time} units hidden`);

db.close();
