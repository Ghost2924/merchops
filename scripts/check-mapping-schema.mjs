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

const [schema, sample] = await Promise.all([
  db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='marketplace_item_mappings'"),
  db.execute('SELECT * FROM marketplace_item_mappings LIMIT 5'),
]);

console.log('Schema:', schema.rows[0]?.sql);
console.log('\nSample rows:');
for (const r of sample.rows) console.log(JSON.stringify(r));

// Also check sku_mappings table
const [skuSchema, skuSample] = await Promise.all([
  db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='sku_mappings'"),
  db.execute('SELECT * FROM sku_mappings LIMIT 5'),
]);
console.log('\nsku_mappings schema:', skuSchema.rows[0]?.sql);
console.log('\nsku_mappings sample:');
for (const r of skuSample.rows) console.log(JSON.stringify(r));

process.exit(0);
