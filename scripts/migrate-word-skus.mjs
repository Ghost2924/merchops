/**
 * One-shot migration: rename word-suffix and -1 suffix SKU variants in orders.
 * e.g. "AM5271-one" → "AM5271", "AM5233-1" → "AM5233", "AM5243B-two" → "AM5243B" (qty × 2)
 *
 * Usage:
 *   node scripts/migrate-word-skus.mjs [--dry-run]
 */

import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

// Load .env.local
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

const DRY_RUN = process.argv.includes('--dry-run');
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('Missing env vars: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

const WORD_PACK_SUFFIXES = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, eight: 8, ten: 10, twelve: 12,
};

/** Returns { baseSku, multiplier } if SKU has a strippable suffix, else null. */
function parseSuffix(sku) {
  // Word suffix: -one, -two, etc.
  const wordMatch = sku.match(/^(.+)-([a-zA-Z]+)$/);
  if (wordMatch) {
    const word = wordMatch[2].toLowerCase();
    if (word in WORD_PACK_SUFFIXES) {
      return { baseSku: wordMatch[1], multiplier: WORD_PACK_SUFFIXES[word] };
    }
  }
  // Numeric suffix -1 (single-unit variant, merge with no qty change)
  const oneMatch = sku.match(/^(.+)-1$/);
  if (oneMatch) {
    return { baseSku: oneMatch[1], multiplier: 1 };
  }
  return null;
}

async function main() {
  console.log(DRY_RUN ? '--- DRY RUN ---' : '--- LIVE MIGRATION ---');

  // Find candidates: word-suffix SKUs and -1 suffix SKUs
  const [wordResult, numResult] = await Promise.all([
    db.execute(`SELECT DISTINCT sku FROM orders WHERE sku GLOB '*-[a-zA-Z]*'`),
    db.execute(`SELECT DISTINCT sku FROM orders WHERE sku GLOB '*-1'`),
  ]);

  const seen = new Set();
  const toMigrate = [];

  for (const row of [...wordResult.rows, ...numResult.rows]) {
    const sku = row.sku;
    if (seen.has(sku)) continue;
    seen.add(sku);
    const parsed = parseSuffix(sku);
    if (parsed) toMigrate.push({ rawSku: sku, ...parsed });
  }

  if (toMigrate.length === 0) {
    console.log('No suffix SKUs found. Nothing to do.');
    return;
  }

  console.log(`Found ${toMigrate.length} SKU(s) to migrate:`);
  for (const { rawSku, baseSku, multiplier } of toMigrate) {
    console.log(`  ${rawSku} → ${baseSku} (multiplier: ${multiplier})`);
  }

  if (DRY_RUN) {
    console.log('\nDry run complete. Re-run without --dry-run to apply.');
    return;
  }

  let totalUpdated = 0;

  for (const { rawSku, baseSku, multiplier } of toMigrate) {
    const rows = await db.execute({
      sql: `SELECT id, order_id, order_date, qty, unit_price, total_price FROM orders WHERE sku = ?`,
      args: [rawSku],
    });

    console.log(`\nMigrating ${rows.rows.length} rows: ${rawSku} → ${baseSku}`);

    const batch = rows.rows.map((r) => {
      const newQty = r.qty * multiplier;
      const newUnitPrice = newQty > 0 ? r.total_price / newQty : r.unit_price;
      const newOrderId = String(r.order_id).replace(rawSku, baseSku);
      return {
        // If a row with (newOrderId, baseSku) already exists, merge qty/revenue into it
        // then delete the old raw-SKU row.
        sql: `INSERT INTO orders (order_id, order_date, sku, qty, unit_price, total_price)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(order_id, sku) DO UPDATE SET
                qty         = qty + excluded.qty,
                total_price = total_price + excluded.total_price,
                unit_price  = CASE WHEN (qty + excluded.qty) > 0
                                THEN (total_price + excluded.total_price) / (qty + excluded.qty)
                                ELSE unit_price END`,
        args: [newOrderId, r.order_date, baseSku, newQty, Math.round(newUnitPrice * 100) / 100, r.total_price],
      };
    });

    const deleteBatch = rows.rows.map((r) => ({
      sql: `DELETE FROM orders WHERE id = ?`,
      args: [r.id],
    }));

    const BATCH = 100;
    for (let i = 0; i < batch.length; i += BATCH) {
      await db.batch(batch.slice(i, i + BATCH));
    }
    // Delete the old raw-SKU rows now that data is merged into baseSku rows
    for (let i = 0; i < deleteBatch.length; i += BATCH) {
      await db.batch(deleteBatch.slice(i, i + BATCH));
    }
    totalUpdated += rows.rows.length;
    console.log(`  ✓ Updated ${rows.rows.length} rows`);
  }

  // Migrate inventory_snapshots
  for (const { rawSku, baseSku } of toMigrate) {
    const snapRows = await db.execute({
      sql: `SELECT id, snapshot_date, qty_available FROM inventory_snapshots WHERE sku = ?`,
      args: [rawSku],
    });
    if (snapRows.rows.length === 0) continue;

    console.log(`\nMigrating ${snapRows.rows.length} inventory_snapshots: ${rawSku} → ${baseSku}`);
    const snapBatch = snapRows.rows.map((r) => ({
      sql: `INSERT OR REPLACE INTO inventory_snapshots (sku, snapshot_date, qty_available)
            VALUES (?, ?, ?)`,
      args: [baseSku, r.snapshot_date, r.qty_available],
    }));
    const BATCH = 100;
    for (let i = 0; i < snapBatch.length; i += BATCH) {
      await db.batch(snapBatch.slice(i, i + BATCH));
    }
    await db.execute({ sql: `DELETE FROM inventory_snapshots WHERE sku = ?`, args: [rawSku] });
    console.log(`  ✓ Migrated ${snapRows.rows.length} snapshot rows`);
  }

  console.log(`\nDone. Total order rows updated: ${totalUpdated}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
