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

// All mapped SKUs (both tables)
const [mim, sm] = await Promise.all([
  db.execute('SELECT marketplace_sku FROM marketplace_item_mappings'),
  db.execute('SELECT source_sku FROM sku_mappings WHERE active = 1'),
]);
const mapped = new Set([...mim.rows.map(r => r.marketplace_sku), ...sm.rows.map(r => r.source_sku)]);

// All inventory SKUs
const inv = await db.execute('SELECT sku FROM inventory_products');
const inventorySkus = new Set(inv.rows.map(r => r.sku));

// Unmapped order SKUs with qty
const orders = await db.execute(`
  SELECT sku, SUM(qty) as total_qty, COUNT(*) as order_rows
  FROM orders
  WHERE order_date >= '2024-01-01' AND order_date <= '2025-09-30'
  GROUP BY sku
  ORDER BY total_qty DESC
`);

const unmapped = orders.rows.filter(r => !mapped.has(r.sku));

// Categorize
const looksLikeSku = unmapped.filter(r => /^[A-Z0-9]{2,}[-]?/i.test(r.sku) && r.sku.length < 30 && !/^B0[A-Z0-9]{8}$/.test(r.sku));
const looksLikeAsin = unmapped.filter(r => /^B0[A-Z0-9]{8}$/.test(r.sku));
const junk = unmapped.filter(r => !(/^[A-Z0-9]{2,}[-]?/i.test(r.sku) && r.sku.length < 30));

console.log(`\nTotal unmapped order SKUs (2024-2025): ${unmapped.length}`);
console.log(`  Looks like warehouse SKU: ${looksLikeSku.length}`);
console.log(`  Looks like ASIN:          ${looksLikeAsin.length}`);
console.log(`  Junk/other:               ${junk.length}`);

console.log(`\nTop 40 warehouse-looking unmapped SKUs (by qty sold):`);
for (const r of looksLikeSku.slice(0, 40)) {
  const inInv = inventorySkus.has(r.sku) ? '✓INV' : '✗';
  console.log(`  ${String(r.sku).padEnd(30)} qty:${String(r.total_qty).padStart(6)}  rows:${String(r.order_rows).padStart(5)}  ${inInv}`);
}

process.exit(0);
