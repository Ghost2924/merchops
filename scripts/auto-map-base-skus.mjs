/**
 * Auto-map base SKUs (e.g. AM5237) to their -1 variant in inventory_products.
 * Pattern: orders contain "AM5237" but inventory only has "AM5237-1".
 * Base SKU = single unit = -1 variant.
 *
 * Usage: node scripts/auto-map-base-skus.mjs
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

// All mapped SKUs
const [mim, sm] = await Promise.all([
  db.execute('SELECT marketplace_sku FROM marketplace_item_mappings'),
  db.execute('SELECT source_sku FROM sku_mappings WHERE active = 1'),
]);
const alreadyMapped = new Set([
  ...mim.rows.map(r => r.marketplace_sku),
  ...sm.rows.map(r => r.source_sku),
]);

// All inventory SKUs
const inv = await db.execute('SELECT sku FROM inventory_products');
const inventorySkus = new Set(inv.rows.map(r => r.sku));

// All unmapped order SKUs (2024+) with volume
const orders = await db.execute(`
  SELECT sku, SUM(qty) as total_qty
  FROM orders
  WHERE order_date >= '2024-01-01'
  GROUP BY sku
  ORDER BY total_qty DESC
`);

const unmapped = orders.rows.filter(r => r.sku && !alreadyMapped.has(r.sku) && !inventorySkus.has(r.sku));

console.log(`\n🔍  Finding base SKU → -1 variant mappings...`);
console.log(`    Unmapped order SKUs: ${unmapped.length}\n`);

const toMap = []; // { source, target, qty }

for (const row of unmapped) {
  const sku = row.sku;

  // Try: base → base-1
  if (inventorySkus.has(`${sku}-1`)) {
    toMap.push({ source: sku, target: `${sku}-1`, qty: row.total_qty, rule: 'base→-1' });
    continue;
  }

  // Try: base → base-one
  if (inventorySkus.has(`${sku}-one`)) {
    toMap.push({ source: sku, target: `${sku}-one`, qty: row.total_qty, rule: 'base→-one' });
    continue;
  }

  // Try: lowercase match in inventory
  const lower = sku.toLowerCase();
  const lowerMatch = [...inventorySkus].find(s => s.toLowerCase() === lower);
  if (lowerMatch) {
    toMap.push({ source: sku, target: lowerMatch, qty: row.total_qty, rule: 'case-fix' });
    continue;
  }
}

console.log(`    Mappable via base→-1 or case-fix: ${toMap.length}`);
console.log(`\n    Mappings to insert:`);
for (const m of toMap.slice(0, 30)) {
  console.log(`      ${m.source.padEnd(30)} → ${m.target.padEnd(30)} [${m.rule}] qty:${m.qty}`);
}
if (toMap.length > 30) console.log(`      ... and ${toMap.length - 30} more`);

if (toMap.length === 0) {
  console.log('\n✅  Nothing to map.');
  process.exit(0);
}

// Insert into both mapping tables
const BATCH = 100;
let inserted = 0;
for (let i = 0; i < toMap.length; i += BATCH) {
  const chunk = toMap.slice(i, i + BATCH);

  await db.batch(chunk.map(m => ({
    sql: `INSERT OR IGNORE INTO sku_mappings
            (source_sku, marketplace, teapplix_sku, mapping_type, active, confidence, notes)
          VALUES (?, 'UNKNOWN', ?, 'auto_base_sku', 1, 0.9, ?)`,
    args: [m.source, m.target, `auto: ${m.rule}`],
  })));

  await db.batch(chunk.map(m => ({
    sql: `INSERT OR IGNORE INTO marketplace_item_mappings
            (marketplace_id, marketplace_sku, internal_sku)
          VALUES ('UNKNOWN', ?, ?)`,
    args: [m.source, m.target],
  })));

  inserted += chunk.length;
}

const [afterMim, afterSm] = await Promise.all([
  db.execute('SELECT COUNT(*) as cnt FROM marketplace_item_mappings'),
  db.execute('SELECT COUNT(*) as cnt FROM sku_mappings'),
]);

console.log(`\n✅  Done!`);
console.log(`    Mappings inserted         : ${inserted}`);
console.log(`    marketplace_item_mappings : ${afterMim.rows[0].cnt} total`);
console.log(`    sku_mappings              : ${afterSm.rows[0].cnt} total`);
console.log(`\n    Re-run allocation backfill to pick up new mappings:`);
console.log(`    node scripts/backfill-allocations.mjs 2024-01-01 2025-09-30`);

process.exit(0);
