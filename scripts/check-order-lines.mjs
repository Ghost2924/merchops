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

const [olSchema, olRange, olMonths] = await Promise.all([
  db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='order_lines'"),
  db.execute("SELECT MIN(order_date) as min_d, MAX(order_date) as max_d, COUNT(*) as cnt FROM order_lines"),
  db.execute(`SELECT strftime('%Y-%m', order_date) as month, COUNT(*) as cnt 
              FROM order_lines 
              WHERE order_date >= '2025-01-01' 
              GROUP BY month ORDER BY month`),
]);

console.log('\n📋 order_lines schema:');
console.log(olSchema.rows[0]?.sql ?? 'table not found');

console.log('\n📊 order_lines range:', JSON.stringify(olRange.rows[0]));

console.log('\n📅 order_lines by month (2025+):');
for (const r of olMonths.rows) console.log(`   ${r.month}: ${r.cnt} rows`);

// Check Jun-Aug 2025 specifically
const [jun, jul, aug] = await Promise.all([
  db.execute(`SELECT COUNT(*) as cnt, SUM(qty_sold) as total_qty FROM order_lines WHERE order_date LIKE '2025-06%' AND mapping_status = 'mapped'`),
  db.execute(`SELECT COUNT(*) as cnt, SUM(qty_sold) as total_qty FROM order_lines WHERE order_date LIKE '2025-07%' AND mapping_status = 'mapped'`),
  db.execute(`SELECT COUNT(*) as cnt, SUM(qty_sold) as total_qty FROM order_lines WHERE order_date LIKE '2025-08%' AND mapping_status = 'mapped'`),
]);
console.log('\n📅 Jun 2025 mapped order_lines:', JSON.stringify(jun.rows[0]));
console.log('📅 Jul 2025 mapped order_lines:', JSON.stringify(jul.rows[0]));
console.log('📅 Aug 2025 mapped order_lines:', JSON.stringify(aug.rows[0]));

process.exit(0);
