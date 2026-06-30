#!/usr/bin/env node
/**
 * Fix 1: Purge phantom direct allocations.
 *
 * Teapplix sends two lines per multi-pack order:
 *   1. ASIN line (e.g. B0FHT53VLL → AM5304-50) → combo → correct combo_explode allocation
 *   2. Bare SKU line (e.g. AM5304 → AM5304-1) → inventory → phantom direct allocation
 *
 * Both land in inventory_allocations with different order_line_ids, causing double-count.
 * This script deletes the phantom direct allocations.
 * order_lines rows are preserved (revenue tracking intact).
 *
 * Safe to re-run (idempotent).
 * Reversible: node scripts/backfill-order-allocations.mjs --force
 */
import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

const envPath = new URL('../.env.local', import.meta.url).pathname;
try {
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
} catch { /* env already set */ }

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const DRY_RUN = process.argv.includes('--dry-run');

console.log(`\nFix 1: Purge phantom direct allocations`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE — will delete rows'}\n`);

// Count before
const before = await db.execute(`SELECT COUNT(*) AS cnt FROM inventory_allocations`);
console.log(`inventory_allocations before: ${before.rows[0].cnt}`);

// Identify phantom direct allocation order_line_ids
const phantomResult = await db.execute(`
  SELECT ia.order_line_id, ia.inventory_sku, ia.qty_depleted
  FROM inventory_allocations ia
  JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
  WHERE ia.allocation_type = 'direct'
    AND EXISTS (
      SELECT 1 FROM order_lines combo_ol
      WHERE combo_ol.customer_order_id = ol.customer_order_id
        AND combo_ol.order_line_id != ol.order_line_id
        AND combo_ol.resolved_product_type = 'combo'
        AND combo_ol.qty_sold = ol.qty_sold
    )
`);

console.log(`Phantom direct allocations found: ${phantomResult.rows.length}`);
const totalPhantomQty = phantomResult.rows.reduce((s, r) => s + Number(r.qty_depleted), 0);
console.log(`Total phantom qty_depleted: ${totalPhantomQty}`);

if (phantomResult.rows.length > 0 && !DRY_RUN) {
  // Delete in batches of 100
  const ids = phantomResult.rows.map(r => r.order_line_id);
  const BATCH = 100;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const ph = chunk.map(() => '?').join(',');
    const res = await db.execute({
      sql: `DELETE FROM inventory_allocations
            WHERE order_line_id IN (${ph})
              AND allocation_type = 'direct'`,
      args: chunk,
    });
    deleted += res.rowsAffected;
  }
  console.log(`Deleted: ${deleted} rows`);
}

const after = await db.execute(`SELECT COUNT(*) AS cnt FROM inventory_allocations`);
console.log(`inventory_allocations after: ${after.rows[0].cnt}`);
console.log(`\nDone. Cache will clear on next sync or server restart.`);

await db.close();
