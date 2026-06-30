/**
 * Auto-map unmapped SKUs that already exist in inventory_products.
 *
 * The backfill-allocations script skips SKUs that have no entry in
 * marketplace_item_mappings. But many of these SKUs ARE the internal
 * Teapplix SKU — they just need a self-mapping (marketplace_sku → same sku).
 *
 * This script:
 *   1. Finds all SKUs in the orders table that have no mapping
 *   2. Checks if they exist directly in inventory_products
 *   3. Inserts a self-mapping for each match
 *
 * Usage:
 *   node scripts/auto-map-inventory-skus.mjs
 */

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

console.log('\n🔍  Auto-mapping unmapped SKUs that exist in inventory_products...\n');

// Get all existing mapping keys from BOTH mapping tables
const [mim, sm] = await Promise.all([
  db.execute('SELECT marketplace_sku FROM marketplace_item_mappings'),
  db.execute('SELECT source_sku FROM sku_mappings WHERE active = 1'),
]);
const alreadyMapped = new Set([
  ...mim.rows.map(r => r.marketplace_sku),
  ...sm.rows.map(r => r.source_sku),
]);
console.log(`    Existing mappings (marketplace_item_mappings): ${mim.rows.length}`);
console.log(`    Existing mappings (sku_mappings):              ${sm.rows.length}`);

// Get all inventory product SKUs
const inventoryResult = await db.execute('SELECT sku FROM inventory_products');
const inventorySkus = new Set(inventoryResult.rows.map(r => r.sku));
console.log(`    Inventory products: ${inventorySkus.size}`);

// Get all distinct SKUs from orders that have no mapping
const ordersSkus = await db.execute('SELECT DISTINCT sku FROM orders');
const unmappedOrderSkus = ordersSkus.rows
  .map(r => r.sku)
  .filter(sku => sku && !alreadyMapped.has(sku));

console.log(`    Unmapped order SKUs: ${unmappedOrderSkus.length}`);

// Find which unmapped order SKUs exist directly in inventory_products (self-mappable)
const selfMappable = unmappedOrderSkus.filter(sku => inventorySkus.has(sku));
console.log(`    Self-mappable (SKU exists in inventory): ${selfMappable.length}`);

if (selfMappable.length === 0) {
  console.log('\n✅  Nothing to auto-map.');
  process.exit(0);
}

console.log('\n    Sample SKUs being mapped:');
for (const sku of selfMappable.slice(0, 20)) {
  console.log(`      ${sku} → ${sku}`);
}
if (selfMappable.length > 20) {
  console.log(`      ... and ${selfMappable.length - 20} more`);
}

// Insert self-mappings into BOTH tables so all pipelines can find them
const BATCH = 100;
let inserted = 0;
for (let i = 0; i < selfMappable.length; i += BATCH) {
  const chunk = selfMappable.slice(i, i + BATCH);

  // sku_mappings — used by the live sync pipeline (buildMappingLookup in queries.ts)
  await db.batch(
    chunk.map(sku => ({
      sql: `INSERT OR IGNORE INTO sku_mappings
              (source_sku, marketplace, teapplix_sku, mapping_type, active, confidence)
            VALUES (?, 'UNKNOWN', ?, 'auto_self_map', 1, 1.0)`,
      args: [sku, sku],
    }))
  );

  // marketplace_item_mappings — used by backfill-allocations.mjs
  await db.batch(
    chunk.map(sku => ({
      sql: `INSERT OR IGNORE INTO marketplace_item_mappings
              (marketplace_id, marketplace_sku, internal_sku)
            VALUES ('UNKNOWN', ?, ?)`,
      args: [sku, sku],
    }))
  );

  inserted += chunk.length;
  process.stdout.write(`\r    Inserting... ${inserted}/${selfMappable.length}`);
}

const [afterMim, afterSm] = await Promise.all([
  db.execute('SELECT COUNT(*) as cnt FROM marketplace_item_mappings'),
  db.execute('SELECT COUNT(*) as cnt FROM sku_mappings'),
]);
console.log(`\n\n✅  Done!`);
console.log(`    Self-mappings added       : ${selfMappable.length}`);
console.log(`    marketplace_item_mappings : ${afterMim.rows[0].cnt} total`);
console.log(`    sku_mappings              : ${afterSm.rows[0].cnt} total`);
console.log(`\n    Next: re-run the allocation backfill to pick up these newly mapped SKUs:`);
console.log(`    node scripts/backfill-allocations.mjs 2024-01-01 2025-09-30`);

process.exit(0);
