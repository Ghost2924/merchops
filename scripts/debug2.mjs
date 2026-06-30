import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envLines = readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n');
for (const l of envLines) { const m = l.match(/^([^#=]+)=(.*)/); if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, ''); }

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// 1. What does the monthly SQL return for Jun 2025 (top 20)?
const r1 = await db.execute({
  sql: `SELECT ol.resolved_teapplix_sku AS physical_sku, SUM(ol.qty_sold) AS units
        FROM order_lines ol
        JOIN inventory_products ip ON ip.sku = ol.resolved_teapplix_sku
        WHERE ol.order_date >= '2025-06-01' AND ol.order_date <= '2025-06-30'
          AND ol.mapping_status = 'mapped'
          AND ol.resolved_product_type = 'inventory'
        GROUP BY physical_sku
        ORDER BY units DESC LIMIT 20`,
  args: []
});
console.log('Monthly SQL Jun 2025 top 20 (inventory type):');
for (const r of r1.rows) console.log(' ', r.physical_sku, '=', r.units, 'units');

// 2. What invResult physical SKUs exist for 5234 family?
const r2 = await db.execute(`
  SELECT ip.sku FROM inventory_products ip
  WHERE ip.active = 1
    AND ip.sku NOT IN (SELECT DISTINCT combo_sku FROM combo_components)
    AND ip.sku NOT IN (SELECT DISTINCT cp.sku FROM combo_products cp)
    AND (ip.sku LIKE '5234%' OR ip.sku LIKE 'AM5234%')
  ORDER BY ip.sku
`);
console.log('\ninvResult physical SKUs for 5234 family:');
for (const r of r2.rows) console.log(' ', r.sku);

// 3. Are 5234/AM5234 bare SKUs combos?
const r3 = await db.execute(`
  SELECT cc.combo_sku FROM combo_components cc
  WHERE cc.combo_sku IN ('5234','AM5234','AM5234-1','AM5234-5','AM5234-five')
  GROUP BY cc.combo_sku
`);
console.log('\nBare SKUs that ARE combo_sku in combo_components:', r3.rows.map(r => r.combo_sku));

// 4. Is 5234/AM5234 in combo_products?
const r4 = await db.execute(`SELECT sku FROM combo_products WHERE sku LIKE 'AM5234%' OR sku LIKE '5234%' ORDER BY sku`);
console.log('\ncombo_products for 5234 family:', r4.rows.map(r => r.sku));

// 5. What family key does each physical SKU map to?
// Simulate normalizeFamilyKey: strip AM prefix then check siblings
const allInvSkus = (await db.execute(`
  SELECT ip.sku FROM inventory_products ip
  WHERE ip.active = 1
    AND ip.sku NOT IN (SELECT DISTINCT combo_sku FROM combo_components)
    AND ip.sku NOT IN (SELECT DISTINCT cp.sku FROM combo_products cp)
`)).rows.map(r => r.sku);

console.log(`\nTotal invResult SKUs: ${allInvSkus.length}`);

// Find which monthly SKUs won't match any invResult SKU  
const monthSkus = r1.rows.map(r => r.physical_sku);
console.log('\nMonthly SKUs NOT in invResult (lost in family aggregation):');
for (const sku of monthSkus) {
  const inInv = allInvSkus.includes(sku);
  if (!inInv) console.log(' ', sku, '← NOT in invResult');
}

db.close();
