import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

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

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// Check if AM5237 etc exist anywhere in inventory or combo tables
const topSkus = ['AM5237', 'AM5234', 'AM5233', 'AM5274', 'AM5271', 'AM5234B', 'AM5273', 'AM5275'];

for (const sku of topSkus) {
  const [inv, combo, invLike] = await Promise.all([
    db.execute({ sql: 'SELECT sku, title, current_qty FROM inventory_products WHERE sku = ?', args: [sku] }),
    db.execute({ sql: 'SELECT sku, title FROM combo_products WHERE sku = ?', args: [sku] }),
    db.execute({ sql: 'SELECT sku, title FROM inventory_products WHERE sku LIKE ?', args: [`${sku}%`] }),
  ]);

  const inInv = inv.rows.length > 0;
  const inCombo = combo.rows.length > 0;
  const variants = invLike.rows.map(r => r.sku).slice(0, 5);

  console.log(`\n${sku}:`);
  if (inInv) console.log(`  ✓ inventory_products: qty=${inv.rows[0].current_qty} title="${inv.rows[0].title}"`);
  if (inCombo) console.log(`  ✓ combo_products: "${combo.rows[0].title}"`);
  if (!inInv && !inCombo) console.log(`  ✗ not in any product table`);
  if (variants.length > 0) console.log(`  variants in inventory: ${variants.join(', ')}`);
}

process.exit(0);
