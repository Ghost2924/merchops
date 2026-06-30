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

const [mim, sm] = await Promise.all([
  db.execute('SELECT marketplace_sku FROM marketplace_item_mappings'),
  db.execute('SELECT source_sku FROM sku_mappings WHERE active = 1'),
]);
const mapped = new Set([...mim.rows.map(r => r.marketplace_sku), ...sm.rows.map(r => r.source_sku)]);
const inv = await db.execute('SELECT sku FROM inventory_products');
const inventorySkus = new Set(inv.rows.map(r => r.sku));

// Get unmapped SKUs with last order date and summer 2025 qty
const orders = await db.execute(`
  SELECT sku,
         MAX(order_date) as last_order,
         MIN(order_date) as first_order,
         SUM(qty) as total_qty,
         SUM(CASE WHEN order_date >= '2025-06-01' AND order_date <= '2025-08-31' THEN qty ELSE 0 END) as summer25_qty
  FROM orders
  WHERE order_date >= '2024-01-01'
  GROUP BY sku
  ORDER BY summer25_qty DESC, total_qty DESC
`);

const unmapped = orders.rows.filter(r => r.sku && !mapped.has(r.sku) && !inventorySkus.has(r.sku));

const withSummer = unmapped.filter(r => Number(r.summer25_qty) > 0);
const noSummer   = unmapped.filter(r => Number(r.summer25_qty) === 0);

console.log(`\nUnmapped SKUs: ${unmapped.length} total`);
console.log(`  Had summer 2025 orders: ${withSummer.length}  ← THESE AFFECT RESTOCK PLANNER`);
console.log(`  No summer 2025 orders:  ${noSummer.length}  ← safe to ignore\n`);

console.log(`SKUs WITH summer 2025 orders (sorted by summer qty):`);
for (const r of withSummer.slice(0, 40)) {
  console.log(`  ${String(r.sku).padEnd(28)} summer25:${String(r.summer25_qty).padStart(6)}  total:${String(r.total_qty).padStart(7)}  last:${r.last_order}`);
}

process.exit(0);
