/**
 * Debug: why are monthly LY sales so low?
 * Run: node scripts/debug-monthly-sales.mjs [familySku]
 * e.g. node scripts/debug-monthly-sales.mjs AM5234
 */
import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse .env.local manually (no dotenv dep)
const envPath = resolve(__dirname, '../.env.local');
const envLines = readFileSync(envPath, 'utf8').split('\n');
for (const line of envLines) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const targetFamily = process.argv[2] ?? 'AM5234';
// strip leading AM for matching both AM5234* and 5234*
const familyBase = targetFamily.replace(/^AM(?=\d)/, '');

// LY months (from today June 3 2026 → LY = June/May/April 2025)
const lyMonths = [
  { label: 'Jun 2025', start: '2025-06-01', end: '2025-06-30' },
  { label: 'May 2025', start: '2025-05-01', end: '2025-05-31' },
  { label: 'Apr 2025', start: '2025-04-01', end: '2025-04-30' },
];

console.log(`\n=== Diagnostic for family: ${targetFamily} (base: ${familyBase}) ===\n`);

// 1. What physical SKUs exist in inventory_products matching this family?
const invResult = await db.execute({
  sql: `SELECT sku, title, current_qty, active FROM inventory_products WHERE sku LIKE ? OR sku LIKE ? ORDER BY sku`,
  args: [`${familyBase}%`, `AM${familyBase}%`],
});
console.log(`[inventory_products] matching SKUs (${invResult.rows.length} rows):`);
for (const r of invResult.rows) {
  console.log(`  ${r.sku} | qty=${r.current_qty} | active=${r.active} | "${r.title}"`);
}

// 2. What combo_components reference child SKUs in this family?
const comboResult = await db.execute({
  sql: `SELECT combo_sku, child_inventory_sku, quantity FROM combo_components WHERE child_inventory_sku LIKE ? OR child_inventory_sku LIKE ? ORDER BY combo_sku`,
  args: [`${familyBase}%`, `AM${familyBase}%`],
});
console.log(`\n[combo_components] components with child matching family (${comboResult.rows.length} rows):`);
for (const r of comboResult.rows) {
  console.log(`  combo=${r.combo_sku} → child=${r.child_inventory_sku} × ${r.quantity}`);
}

// 3. For each LY month: raw order_lines rows for this family (direct + combo)
for (const { label, start, end } of lyMonths) {
  const directResult = await db.execute({
    sql: `SELECT resolved_teapplix_sku, SUM(qty_sold) AS total_qty, COUNT(*) AS order_count
          FROM order_lines
          WHERE order_date >= ? AND order_date <= ?
            AND mapping_status = 'mapped'
            AND resolved_product_type = 'inventory'
            AND (resolved_teapplix_sku LIKE ? OR resolved_teapplix_sku LIKE ?)
          GROUP BY resolved_teapplix_sku
          ORDER BY resolved_teapplix_sku`,
    args: [start, end, `${familyBase}%`, `AM${familyBase}%`],
  });

  const comboOrderResult = await db.execute({
    sql: `SELECT ol.resolved_teapplix_sku, cc.child_inventory_sku, SUM(ol.qty_sold * cc.quantity) AS total_units, COUNT(*) AS order_count
          FROM order_lines ol
          JOIN combo_components cc ON cc.combo_sku = ol.resolved_teapplix_sku
          WHERE ol.order_date >= ? AND ol.order_date <= ?
            AND ol.mapping_status = 'mapped'
            AND ol.resolved_product_type = 'combo'
            AND (cc.child_inventory_sku LIKE ? OR cc.child_inventory_sku LIKE ?)
          GROUP BY ol.resolved_teapplix_sku, cc.child_inventory_sku
          ORDER BY ol.resolved_teapplix_sku`,
    args: [start, end, `${familyBase}%`, `AM${familyBase}%`],
  });

  const directTotal = directResult.rows.reduce((s, r) => s + Number(r.total_qty), 0);
  const comboTotal = comboOrderResult.rows.reduce((s, r) => s + Number(r.total_units), 0);

  console.log(`\n[${label}] DIRECT orders (total qty=${directTotal}):`);
  if (directResult.rows.length === 0) console.log('  (none)');
  for (const r of directResult.rows) {
    console.log(`  ${r.resolved_teapplix_sku}: ${r.total_qty} units across ${r.order_count} order lines`);
  }

  console.log(`[${label}] COMBO-exploded units (total units=${comboTotal}):`);
  if (comboOrderResult.rows.length === 0) console.log('  (none)');
  for (const r of comboOrderResult.rows) {
    console.log(`  combo=${r.resolved_teapplix_sku} → child=${r.child_inventory_sku}: ${r.total_units} units`);
  }
}

// 4. Check total order_lines count per month to see if data gap exists at all
console.log('\n[order_lines] total rows per LY month (all SKUs):');
for (const { label, start, end } of lyMonths) {
  const countResult = await db.execute({
    sql: `SELECT COUNT(*) AS cnt, SUM(qty_sold) AS total_qty FROM order_lines WHERE order_date >= ? AND order_date <= ? AND mapping_status = 'mapped'`,
    args: [start, end],
  });
  const r = countResult.rows[0];
  console.log(`  ${label}: ${r.cnt} order lines, ${r.total_qty} total qty`);
}

// 5. Check earliest and latest order_date in DB to see data range
const rangeResult = await db.execute(`SELECT MIN(order_date) AS earliest, MAX(order_date) AS latest, COUNT(*) AS total FROM order_lines`);
const range = rangeResult.rows[0];
console.log(`\n[order_lines] data range: ${range.earliest} → ${range.latest} (${range.total} total rows)`);

// 6. Check for unmapped orders in LY months that might belong to this family
const unmappedResult = await db.execute({
  sql: `SELECT raw_storefront_sku, SUM(qty_sold) AS qty, COUNT(*) AS cnt
        FROM order_lines
        WHERE order_date >= '2025-04-01' AND order_date <= '2025-06-30'
          AND mapping_status != 'mapped'
        GROUP BY raw_storefront_sku
        ORDER BY qty DESC
        LIMIT 20`,
  args: [],
});
console.log(`\n[order_lines] UNMAPPED SKUs in Apr-Jun 2025 (top 20):`);
if (unmappedResult.rows.length === 0) console.log('  (none — all orders mapped)');
for (const r of unmappedResult.rows) {
  console.log(`  ${r.raw_storefront_sku}: ${r.qty} qty, ${r.cnt} lines`);
}

db.close();
