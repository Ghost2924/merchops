/**
 * fix-bare-sku-mappings.mjs
 *
 * Fixes ghost SKUs where:
 *   - order_lines.resolved_teapplix_sku = 'AM5237' (bare, no suffix)
 *   - 'AM5237' NOT in inventory_products or combo_products
 *   - 'AM5237-1' IS in inventory_products
 *
 * These bare SKUs slipped through via auto-mapping fallback (Step 1b in
 * buildIngestRows) when the SKU was in inventory at sync time but later
 * removed, or was never suffixed. No sku_mappings rows point to them —
 * the raw storefront SKU IS the bare SKU (e.g. customer order had "AM5237").
 *
 * Actions:
 *   1. Discover all bare ghost resolved_teapplix_skus with a -1 variant
 *   2. Update order_lines: resolved_teapplix_sku bare → + '-1'
 *   3. Update inventory_allocations: source_teapplix_sku + inventory_sku bare → + '-1'
 *   4. Insert/update sku_mappings so future syncs resolve correctly
 *
 * Run dry-run first:   node scripts/fix-bare-sku-mappings.mjs --dry-run
 * Run for real:        node scripts/fix-bare-sku-mappings.mjs --apply
 */

import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envLines = readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n');
for (const l of envLines) {
  const m = l.match(/^([^#=]+)=(.*)/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
}

const DRY_RUN = !process.argv.includes('--apply');
console.log(DRY_RUN
  ? '=== DRY RUN (pass --apply to execute) ===\n'
  : '=== APPLYING CHANGES ===\n');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ── Step 1: Find bare ghost SKUs in order_lines with a -1 variant ─────────────
// Source: distinct resolved_teapplix_sku values that are:
//   - NOT in inventory_products (ghost)
//   - NOT in combo_products (not a combo)
//   - resolved_teapplix_sku + '-1' IS in inventory_products
const ghostResult = await db.execute(`
  SELECT ol.resolved_teapplix_sku        AS bare_sku,
         ol.resolved_teapplix_sku || '-1' AS target_sku,
         SUM(ol.qty_sold)                 AS total_qty,
         COUNT(*)                         AS order_lines
  FROM order_lines ol
  WHERE ol.mapping_status = 'mapped'
    AND ol.resolved_product_type = 'inventory'
    AND ol.resolved_teapplix_sku NOT IN (SELECT sku FROM inventory_products)
    AND ol.resolved_teapplix_sku NOT IN (SELECT sku FROM combo_products)
    AND ol.resolved_teapplix_sku || '-1' IN (SELECT sku FROM inventory_products)
  GROUP BY ol.resolved_teapplix_sku
  ORDER BY total_qty DESC
`);

if (ghostResult.rows.length === 0) {
  console.log('No bare ghost SKUs found with a -1 variant. Nothing to do.');
  db.close();
  process.exit(0);
}

const fixList = ghostResult.rows.map(r => ({
  bare: r.bare_sku,
  target: r.target_sku,
  qty: Number(r.total_qty),
  lines: Number(r.order_lines),
}));

const totalQty = fixList.reduce((s, r) => s + r.qty, 0);
const totalLines = fixList.reduce((s, r) => s + r.lines, 0);

console.log(`Found ${fixList.length} bare ghost SKUs to remap:\n`);
for (const { bare, target, qty, lines } of fixList) {
  console.log(`  ${bare.padEnd(20)} → ${target.padEnd(22)} | ${String(lines).padStart(6)} order_lines | ${String(qty).padStart(8)} units`);
}
console.log(`\nTotal: ${totalLines} order_lines, ${totalQty} units\n`);

if (DRY_RUN) {
  console.log('Dry run complete. Run with --apply to execute.\n');
  db.close();
  process.exit(0);
}

// ── Step 2: Apply ─────────────────────────────────────────────────────────────
const BATCH = 40;

console.log('Updating order_lines + inventory_allocations + sku_mappings...');

for (let i = 0; i < fixList.length; i += BATCH) {
  const chunk = fixList.slice(i, i + BATCH);

  await db.batch(
    chunk.flatMap(({ bare, target }) => [
      // order_lines: fix resolved_teapplix_sku
      {
        sql: `UPDATE order_lines
              SET resolved_teapplix_sku = ?,
                  resolved_product_type = 'inventory',
                  mapping_status        = 'mapped'
              WHERE resolved_teapplix_sku = ?
                AND mapping_status = 'mapped'`,
        args: [target, bare],
      },
      // inventory_allocations: fix source_teapplix_sku
      {
        sql: `UPDATE inventory_allocations
              SET source_teapplix_sku = ?
              WHERE source_teapplix_sku = ?`,
        args: [target, bare],
      },
      // inventory_allocations: fix inventory_sku (direct-type allocations)
      {
        sql: `UPDATE inventory_allocations
              SET inventory_sku = ?
              WHERE inventory_sku = ?`,
        args: [target, bare],
      },
      // sku_mappings: upsert so future syncs resolve bare → -1 correctly
      // raw_storefront_sku = bare (the exact SKU that came in from storefront)
      {
        sql: `INSERT INTO sku_mappings
                (source_sku, marketplace, teapplix_sku, mapping_type, active, confidence, notes, updated_at)
              VALUES (?, 'UNKNOWN', ?, 'auto_bare_fix', 1, 1.0, 'auto-fixed: bare SKU remapped to -1 variant', datetime('now'))
              ON CONFLICT(source_sku, marketplace) DO UPDATE SET
                teapplix_sku = excluded.teapplix_sku,
                mapping_type = excluded.mapping_type,
                active       = 1,
                confidence   = 1.0,
                notes        = excluded.notes,
                updated_at   = datetime('now')`,
        args: [bare, target],
      },
    ])
  );

  process.stdout.write(`  ${Math.min(i + BATCH, fixList.length)}/${fixList.length} SKUs processed\r`);
}

console.log('\n');

// ── Step 3: Verify ────────────────────────────────────────────────────────────
console.log('Verifying...\n');
let issues = 0;
for (const { bare, target } of fixList) {
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS cnt FROM order_lines WHERE resolved_teapplix_sku = ? AND mapping_status = 'mapped'`,
    args: [bare],
  });
  const cnt = Number(r.rows[0].cnt);
  if (cnt > 0) {
    console.log(`  WARNING: ${bare} still has ${cnt} rows in order_lines`);
    issues++;
  }
  const r2 = await db.execute({
    sql: `SELECT SUM(qty_sold) AS qty, COUNT(*) AS lines FROM order_lines WHERE resolved_teapplix_sku = ? AND mapping_status = 'mapped'`,
    args: [target],
  });
  console.log(`  ${bare} → ${target}: now ${r2.rows[0].lines} order_lines, ${r2.rows[0].qty} qty`);
}

if (issues === 0) console.log('\nAll bare SKUs cleared. ✓');
else console.log(`\n${issues} SKUs still have residual rows — check manually.`);

console.log(`
Done. Next steps:
  1. Restart the Next.js dev server (or redeploy) to clear the in-memory restock cache.
  2. Reload the restock/dashboard page — monthly figures should now reflect full sales.
`);

db.close();
