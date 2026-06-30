import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const envLines = readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n');
for (const l of envLines) { const m = l.match(/^([^#=]+)=(.*)/); if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, ''); }
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

const r = await db.execute(`
  SELECT resolved_teapplix_sku, SUM(qty_sold) AS total, COUNT(*) AS lines
  FROM order_lines
  WHERE mapping_status='mapped'
    AND resolved_product_type='inventory'
    AND resolved_teapplix_sku NOT IN (SELECT sku FROM inventory_products)
  GROUP BY resolved_teapplix_sku
  ORDER BY total DESC
  LIMIT 40
`);
console.log('TOP 40 ghost SKUs (all-time qty):');
for (const row of r.rows) console.log(`  ${row.resolved_teapplix_sku}: ${row.total} units, ${row.lines} lines`);

// Check which of top ones have a -1 variant
console.log('\nChecking -1 variants for top 20:');
for (const row of r.rows.slice(0, 20)) {
  const sku = row.resolved_teapplix_sku;
  const c = await db.execute({ sql: `SELECT sku FROM inventory_products WHERE sku=?`, args: [sku + '-1'] });
  const mapped = c.rows.length > 0 ? `→ remap to ${sku}-1` : '→ no -1 variant';
  console.log(`  ${sku}: ${mapped}`);
}
db.close();
