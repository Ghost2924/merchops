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

const [ordersRange, allocRange, monthCounts] = await Promise.all([
  db.execute('SELECT MIN(order_date) as min_d, MAX(order_date) as max_d, COUNT(*) as cnt FROM orders'),
  db.execute('SELECT MIN(order_date) as min_d, MAX(order_date) as max_d, COUNT(*) as cnt FROM order_item_allocations'),
  db.execute(`SELECT strftime('%Y-%m', order_date) as month, COUNT(*) as cnt 
              FROM orders 
              WHERE order_date >= '2024-01-01' 
              GROUP BY month ORDER BY month`),
]);

console.log('\n📊 orders table:');
console.log(`   Range: ${ordersRange.rows[0].min_d} → ${ordersRange.rows[0].max_d}`);
console.log(`   Total: ${ordersRange.rows[0].cnt} rows`);

console.log('\n📊 order_item_allocations table:');
console.log(`   Range: ${allocRange.rows[0].min_d} → ${allocRange.rows[0].max_d}`);
console.log(`   Total: ${allocRange.rows[0].cnt} rows`);

console.log('\n📅 Orders per month (2024+):');
for (const r of monthCounts.rows) {
  console.log(`   ${r.month}: ${r.cnt} rows`);
}

process.exit(0);
