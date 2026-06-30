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

// Check which table the seasonal query uses and what columns are available
const [schema, sample] = await Promise.all([
  db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='inventory_allocations'"),
  db.execute("SELECT * FROM inventory_allocations LIMIT 3"),
]);

console.log('\n📋 inventory_allocations schema:');
console.log(schema.rows[0]?.sql ?? 'table not found');

console.log('\n📋 Sample rows:');
for (const r of sample.rows) console.log(JSON.stringify(r));

// Check what columns exist
const cols = await db.execute("PRAGMA table_info(inventory_allocations)");
console.log('\n📋 Columns:', cols.rows.map(r => r.name).join(', '));

// Check created_at distribution
const createdAtCheck = await db.execute(`
  SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as cnt 
  FROM inventory_allocations 
  GROUP BY month ORDER BY month
`);
console.log('\n📅 inventory_allocations by created_at month:');
for (const r of createdAtCheck.rows) console.log(`   ${r.month}: ${r.cnt} rows`);

process.exit(0);
