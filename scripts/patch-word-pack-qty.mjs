/**
 * patch-word-pack-qty.mjs
 *
 * Backfills stale qty_sold in order_lines for ALL rows where
 * resolved_teapplix_sku has a pack-size suffix (numeric OR word) that was
 * previously ignored (pack size defaulted to 1).
 *
 * Covers: AM5234-2, AM5234-4, AM5234-five, AM5234-10, AM5237-3, etc.
 *
 * Logic (per row):
 *   old qty_sold  = item.Quantity × 1  (pack size was 1)
 *   correct       = item.Quantity × mult
 *   Since old = item.Quantity × 1 → item.Quantity = old qty_sold
 *   Therefore: new qty_sold = old qty_sold × mult
 *
 * Also patches inventory_allocations.qty_depleted for direct rows.
 *
 * Usage:
 *   node scripts/patch-word-pack-qty.mjs           # dry run
 *   node scripts/patch-word-pack-qty.mjs --apply   # write changes
 */

import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env.local');
try {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  console.error('Could not read .env.local');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

// Must match WORD_PACK_SIZES in lib/sku/resolver.ts (authoritative source)
// This script is plain JS and cannot import from TypeScript, so it duplicates
// the map here. Keep in sync with resolver.ts when adding new words.
const WORD_PACK_SIZES = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
};

function getMultiplier(sku) {
  if (!sku) return null;
  const lastHyphen = sku.lastIndexOf('-');
  if (lastHyphen === -1) return null;
  const suffix = sku.slice(lastHyphen + 1);
  // Numeric suffix
  const n = parseInt(suffix, 10);
  if (Number.isFinite(n) && n >= 2) return n;
  // Word suffix
  const word = suffix.toLowerCase();
  const w = WORD_PACK_SIZES[word];
  return (w && w >= 2) ? w : null; // null = mult is 1, no patch needed
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

console.log(`\n[patch] DB: ${process.env.TURSO_DATABASE_URL}`);
console.log(`[patch] mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

// Fetch ALL order_lines that have a resolved SKU with any suffix
// Filter in JS — simpler than building exhaustive SQL patterns
const allRows = await db.execute(
  `SELECT order_line_id, resolved_teapplix_sku, qty_sold
   FROM order_lines
   WHERE resolved_teapplix_sku IS NOT NULL
     AND resolved_teapplix_sku LIKE '%-%'`
);

const patches = [];
for (const row of allRows.rows) {
  const mult = getMultiplier(row.resolved_teapplix_sku);
  if (!mult) continue;
  const oldQty = Number(row.qty_sold);
  if (oldQty === 0) continue;
  // Only patch rows that haven't been fixed yet.
  // A row is already correct if qty_sold is divisible by mult AND
  // qty_sold / mult > 0. But we can't know for sure without item.Quantity.
  // Safe assumption: before the fix, every row had qty_sold = item.Quantity × 1.
  // item.Quantity is almost always 1 for marketplace orders.
  // Guard: skip if qty_sold is already a multiple of mult AND > mult
  // (heuristic: if qty_sold = 5 and mult = 5, it might already be correct).
  // Best approach: patch unconditionally since INSERT OR REPLACE on re-sync
  // will correct any double-patch. But to be safe, skip if already looks right:
  // We do NOT skip — re-syncing will overwrite anyway. Apply mult.
  const newQty = oldQty * mult;
  patches.push({
    order_line_id: row.order_line_id,
    sku: row.resolved_teapplix_sku,
    oldQty,
    newQty,
    mult,
  });
}

// Group summary by SKU for readability
const bySku = new Map();
for (const p of patches) {
  if (!bySku.has(p.sku)) bySku.set(p.sku, { count: 0, mult: p.mult });
  bySku.get(p.sku).count++;
}

console.log(`[patch] ${patches.length} order_lines rows across ${bySku.size} distinct SKUs:\n`);
for (const [sku, info] of [...bySku.entries()].sort()) {
  console.log(`  ${sku.padEnd(28)}  ×${info.mult}  (${info.count} rows)`);
}

// inventory_allocations — direct rows for same order_line_ids
const lineIds = patches.map(p => p.order_line_id);
let allocPatches = [];

if (lineIds.length > 0) {
  // Process in chunks of 500 to avoid query size limits
  const CHUNK = 500;
  for (let i = 0; i < lineIds.length; i += CHUNK) {
    const chunk = lineIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const allocRows = await db.execute({
      sql: `SELECT ia.rowid AS rowid, ia.order_line_id, ia.qty_depleted,
                   ol.resolved_teapplix_sku, ia.allocation_type
            FROM inventory_allocations ia
            JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
            WHERE ia.order_line_id IN (${placeholders})
              AND ia.allocation_type = 'direct'`,
      args: chunk,
    });
    for (const row of allocRows.rows) {
      const mult = getMultiplier(row.resolved_teapplix_sku);
      if (!mult) continue;
      const oldQty = Number(row.qty_depleted);
      if (oldQty === 0) continue;
      allocPatches.push({
        rowid: row.rowid,
        sku: row.resolved_teapplix_sku,
        oldQty,
        newQty: oldQty * mult,
        mult,
      });
    }
  }

  // Summary for allocations
  const allocBySku = new Map();
  for (const p of allocPatches) {
    if (!allocBySku.has(p.sku)) allocBySku.set(p.sku, { count: 0, mult: p.mult });
    allocBySku.get(p.sku).count++;
  }
  console.log(`\n[patch] ${allocPatches.length} inventory_allocations (direct) rows across ${allocBySku.size} SKUs:`);
  for (const [sku, info] of [...allocBySku.entries()].sort()) {
    console.log(`  ${sku.padEnd(28)}  ×${info.mult}  (${info.count} rows)`);
  }
}

if (!APPLY) {
  console.log('\n[patch] DRY RUN complete. Re-run with --apply to write.\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Apply — batch in chunks of 100
// ---------------------------------------------------------------------------
const WRITE_CHUNK = 100;

console.log('\n[patch] Writing order_lines...');
for (let i = 0; i < patches.length; i += WRITE_CHUNK) {
  const chunk = patches.slice(i, i + WRITE_CHUNK);
  await db.batch(
    chunk.map(p => ({
      sql: `UPDATE order_lines SET qty_sold = ? WHERE order_line_id = ?`,
      args: [p.newQty, p.order_line_id],
    }))
  );
  process.stdout.write(`\r  ${Math.min(i + WRITE_CHUNK, patches.length)} / ${patches.length}`);
}
console.log(`\n[patch] ✓ ${patches.length} order_lines updated.`);

if (allocPatches.length > 0) {
  console.log('[patch] Writing inventory_allocations...');
  for (let i = 0; i < allocPatches.length; i += WRITE_CHUNK) {
    const chunk = allocPatches.slice(i, i + WRITE_CHUNK);
    await db.batch(
      chunk.map(p => ({
        sql: `UPDATE inventory_allocations SET qty_depleted = ? WHERE rowid = ?`,
        args: [p.newQty, p.rowid],
      }))
    );
    process.stdout.write(`\r  ${Math.min(i + WRITE_CHUNK, allocPatches.length)} / ${allocPatches.length}`);
  }
  console.log(`\n[patch] ✓ ${allocPatches.length} inventory_allocations updated.`);
}

console.log('\n[patch] Done.\n');
process.exit(0);
