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

const [mappings, inventory, unmapped] = await Promise.all([
  db.execute('SELECT COUNT(*) as cnt FROM marketplace_item_mappings'),
  db.execute('SELECT sku FROM inventory_products ORDER BY sku ASC'),
  db.execute('SELECT raw_storefront_sku, qty_sold, order_count FROM unmapped_skus ORDER BY qty_sold DESC LIMIT 40'),
]);

const inventorySkus = new Set(inventory.rows.map(r => r.sku));

console.log('Mappings in DB:', mappings.rows[0].cnt);
console.log('Inventory products:', inventorySkus.size);
console.log('\nTop unmapped SKUs (checking if they exist in inventory_products):');
for (const r of unmapped.rows) {
  const inInventory = inventorySkus.has(r.raw_storefront_sku) ? '✓ IN INVENTORY' : '✗ not in inventory';
  console.log(`  ${r.raw_storefront_sku} | qty: ${r.qty_sold} | orders: ${r.order_count} | ${inInventory}`);
}

process.exit(0);
