/**
 * Removes stale inventory rows that don't match the canonical SKU format
 * produced by the current canonicalizeSku() function.
 * Safe to run multiple times (idempotent).
 *
 * Usage: node scripts/clean-inventory.mjs [--dry-run]
 */

import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

const envLines = readFileSync(new URL('../.env.local', import.meta.url).pathname, 'utf8').split('\n');
for (const line of envLines) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq < 0) continue;
  const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim();
  if (!process.env[k]) process.env[k] = v;
}

const DRY_RUN = process.argv.includes('--dry-run');
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

/** Mirrors canonicalizeSku from lib/db/queries.ts */
function canonicalizeSku(raw) {
  let s = (raw ?? '').trim();
  const numMatch = s.match(/^(.+)-(\d+)$/);
  if (numMatch) s = numMatch[1];
  if (s.startsWith('AM-')) {
    // already canonical
  } else if (/^AM\d/i.test(s)) {
    s = 'AM-' + s.slice(2);
  } else if (!s.toUpperCase().startsWith('AM')) {
    s = 'AM-' + s;
  }
  s = s.replace(/^AM-AM-/i, 'AM-');
  return s;
}

const all = await db.execute('SELECT sku FROM inventory');
const stale = all.rows
  .map(r => r.sku)
  .filter(sku => canonicalizeSku(sku) !== sku);

console.log(`Total rows: ${all.rows.length}`);
console.log(`Stale (non-canonical) rows: ${stale.length}`);
if (stale.length > 0) {
  console.log('Sample stale SKUs:', stale.slice(0, 20));
}

if (DRY_RUN) {
  console.log('\nDry run — no changes made. Remove --dry-run to delete stale rows.');
  process.exit(0);
}

if (stale.length === 0) {
  console.log('Nothing to clean.');
  process.exit(0);
}

// Delete in batches
const BATCH = 100;
let deleted = 0;
for (let i = 0; i < stale.length; i += BATCH) {
  const chunk = stale.slice(i, i + BATCH);
  const placeholders = chunk.map(() => '?').join(',');
  await db.execute({ sql: `DELETE FROM inventory WHERE sku IN (${placeholders})`, args: chunk });
  deleted += chunk.length;
}

// Also clean stale snapshot rows
const snapStale = await db.execute('SELECT DISTINCT sku FROM inventory_snapshots');
const snapSkusToDelete = snapStale.rows
  .map(r => r.sku)
  .filter(sku => canonicalizeSku(sku) !== sku);

if (snapSkusToDelete.length > 0) {
  for (let i = 0; i < snapSkusToDelete.length; i += BATCH) {
    const chunk = snapSkusToDelete.slice(i, i + BATCH);
    const placeholders = chunk.map(() => '?').join(',');
    await db.execute({ sql: `DELETE FROM inventory_snapshots WHERE sku IN (${placeholders})`, args: chunk });
  }
  console.log(`Deleted ${snapSkusToDelete.length} stale snapshot rows.`);
}

const remaining = await db.execute('SELECT COUNT(*) as cnt FROM inventory');
console.log(`\nDeleted ${deleted} stale inventory rows. Remaining: ${remaining.rows[0].cnt}`);
process.exit(0);
