import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const envLines = readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n');
for (const l of envLines) { const m = l.match(/^([^#=]+)=(.*)/); if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, ''); }
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// Does AM5237 appear in sku_mappings as a teapplix_sku?
const r1 = await db.execute(`SELECT source_sku, teapplix_sku, active FROM sku_mappings WHERE teapplix_sku IN ('AM5237','AM5234','AM5233') LIMIT 10`);
console.log('sku_mappings rows with bare ghost as teapplix_sku:');
for (const r of r1.rows) console.log(' ', r.source_sku, '->', r.teapplix_sku, 'active=', r.active);
if (r1.rows.length === 0) console.log('  (none)');

// So how did these end up in order_lines? Via auto-mapping (Step 1b in buildIngestRows)?
// Check what raw_storefront_sku maps to AM5237 in order_lines
const r2 = await db.execute(`
  SELECT raw_storefront_sku, resolved_teapplix_sku, COUNT(*) AS cnt, SUM(qty_sold) AS qty
  FROM order_lines
  WHERE resolved_teapplix_sku = 'AM5237'
    AND mapping_status = 'mapped'
  GROUP BY raw_storefront_sku
  ORDER BY qty DESC
  LIMIT 10
`);
console.log('\norder_lines: raw SKUs that resolve to AM5237 (top 10):');
for (const r of r2.rows) console.log(' ', r.raw_storefront_sku, '->', r.resolved_teapplix_sku, r.qty, 'units');

// Check if AM5237 itself is in inventory_products (as an active SKU)
const r3 = await db.execute(`SELECT sku, active, current_qty FROM inventory_products WHERE sku IN ('AM5237','AM5237-1') ORDER BY sku`);
console.log('\ninventory_products for AM5237 / AM5237-1:');
for (const r of r3.rows) console.log(' ', r.sku, 'active=', r.active, 'qty=', r.current_qty);
if (r3.rows.length === 0) console.log('  (none)');

// And combo_products?
const r4 = await db.execute(`SELECT sku, active FROM combo_products WHERE sku LIKE 'AM5237%' ORDER BY sku`);
console.log('\ncombo_products AM5237*:', r4.rows.map(r => r.sku + '(active='+r.active+')'));

db.close();
