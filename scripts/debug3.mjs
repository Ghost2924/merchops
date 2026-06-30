import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envLines = readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n');
for (const l of envLines) { const m = l.match(/^([^#=]+)=(.*)/); if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, ''); }

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// The monthly SQL uses UNION ALL of:
//   (A) direct inventory orders: resolved_product_type = 'inventory'
//   (B) combo-exploded: resolved_product_type = 'combo' JOIN combo_components
// Run BOTH for AM5234 family for Jun 2025

console.log('=== Jun 2025: Full monthly SQL (both branches) for 5234 family ===\n');

// Branch A: direct inventory
const a = await db.execute({
  sql: `SELECT ol.resolved_teapplix_sku AS physical_sku, SUM(ol.qty_sold) AS units, COUNT(*) AS lines
        FROM order_lines ol
        JOIN inventory_products ip ON ip.sku = ol.resolved_teapplix_sku
        WHERE ol.order_date >= '2025-06-01' AND ol.order_date <= '2025-06-30'
          AND ol.mapping_status = 'mapped'
          AND ol.resolved_product_type = 'inventory'
          AND (ol.resolved_teapplix_sku LIKE '5234%' OR ol.resolved_teapplix_sku LIKE 'AM5234%')
        GROUP BY physical_sku`,
  args: []
});
console.log('Branch A (direct inventory):');
let totalA = 0;
for (const r of a.rows) { console.log(`  ${r.physical_sku}: ${r.units} units (${r.lines} lines)`); totalA += Number(r.units); }
if (a.rows.length === 0) console.log('  (none)');
console.log(`  TOTAL A: ${totalA}`);

// Branch B: combo-exploded
const b = await db.execute({
  sql: `SELECT cc.child_inventory_sku AS physical_sku, SUM(ol.qty_sold * cc.quantity) AS units, COUNT(*) AS lines
        FROM order_lines ol
        JOIN combo_components cc ON cc.combo_sku = ol.resolved_teapplix_sku
        JOIN inventory_products ip ON ip.sku = cc.child_inventory_sku
        WHERE ol.order_date >= '2025-06-01' AND ol.order_date <= '2025-06-30'
          AND ol.mapping_status = 'mapped'
          AND ol.resolved_product_type = 'combo'
          AND (cc.child_inventory_sku LIKE '5234%' OR cc.child_inventory_sku LIKE 'AM5234%')
        GROUP BY physical_sku`,
  args: []
});
console.log('\nBranch B (combo-exploded):');
let totalB = 0;
for (const r of b.rows) { console.log(`  child=${r.physical_sku}: ${r.units} units (${r.lines} order lines)`); totalB += Number(r.units); }
if (b.rows.length === 0) console.log('  (none)');
console.log(`  TOTAL B: ${totalB}`);

// What combo orders exist for AM5234 family combos?
const comboOrders = await db.execute({
  sql: `SELECT ol.resolved_teapplix_sku, ol.resolved_product_type, SUM(ol.qty_sold) AS qty, COUNT(*) AS lines
        FROM order_lines ol
        WHERE ol.order_date >= '2025-06-01' AND ol.order_date <= '2025-06-30'
          AND ol.mapping_status = 'mapped'
          AND (ol.resolved_teapplix_sku LIKE '5234%' OR ol.resolved_teapplix_sku LIKE 'AM5234%')
        GROUP BY ol.resolved_teapplix_sku, ol.resolved_product_type
        ORDER BY qty DESC`,
  args: []
});
console.log('\nAll order_lines for 5234 family Jun 2025:');
for (const r of comboOrders.rows) {
  console.log(`  ${r.resolved_teapplix_sku} [${r.resolved_product_type}]: ${r.qty} qty_sold, ${r.lines} lines`);
}

// Key question: what does qty_sold=763 for AM5234 mean?
// Is AM5234 (bare) a valid inventory SKU or a combo?
const am5234Check = await db.execute({
  sql: `SELECT 
    (SELECT COUNT(*) FROM inventory_products WHERE sku='AM5234') as in_inv,
    (SELECT COUNT(*) FROM combo_products WHERE sku='AM5234') as in_combo,
    (SELECT COUNT(*) FROM combo_components WHERE combo_sku='AM5234') as in_cc`,
  args: []
});
const c = am5234Check.rows[0];
console.log(`\nAM5234 bare: in_inventory_products=${c.in_inv}, in_combo_products=${c.in_combo}, in_combo_components_as_parent=${c.in_cc}`);

// Same for 5234 bare
const s5234Check = await db.execute({
  sql: `SELECT 
    (SELECT COUNT(*) FROM inventory_products WHERE sku='5234') as in_inv,
    (SELECT COUNT(*) FROM combo_products WHERE sku='5234') as in_combo,
    (SELECT COUNT(*) FROM combo_components WHERE combo_sku='5234') as in_cc`,
  args: []
});
const d = s5234Check.rows[0];
console.log(`5234 bare: in_inventory_products=${d.in_inv}, in_combo_products=${d.in_combo}, in_combo_components_as_parent=${d.in_cc}`);

// What's the pack multiplier for AM5234 bare? It has no suffix → mult=1
// So 763 orders of AM5234 (bare) → 763 units. Does AM5234 exist in inventory_products?
const am5234inv = await db.execute(`SELECT sku, current_qty, active FROM inventory_products WHERE sku='AM5234'`);
console.log('\nAM5234 in inventory_products:', am5234inv.rows);

db.close();
