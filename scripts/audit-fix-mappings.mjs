/**
 * Audit and fix marketplace_item_mappings where internal_sku has a pack suffix.
 *
 * Problem:
 *   Mappings like B0BRPYQ2XY → AM5233-2 are wrong.
 *   The internal_sku should be the BASE sku (AM5233), and the 2× multiplier
 *   should be captured in combo_product_recipes so inventory depletion is correct.
 *
 * What this script does:
 *   1. Reads all marketplace_item_mappings from the DB.
 *   2. Identifies rows where internal_sku has a numeric (≥2) or word pack suffix.
 *   3. Prints a report of all affected mappings.
 *   4. Unless --dry-run:
 *      a. Updates the mapping to point to the base SKU.
 *      b. Inserts a combo_product_recipes row: parent=base_sku+suffix, child=base_sku, qty=multiplier.
 *         (This lets the ingestion pipeline correctly deplete N units per order.)
 *      c. Re-runs allocations for affected orders so physical depletion is corrected.
 *
 * Usage:
 *   node scripts/audit-fix-mappings.mjs --dry-run   # report only
 *   node scripts/audit-fix-mappings.mjs             # apply fixes
 */

import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------
const envPath = new URL('../.env.local', import.meta.url).pathname;
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
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
  console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ---------------------------------------------------------------------------
// SKU suffix parser (mirrors lib/teapplix/parser.ts)
// ---------------------------------------------------------------------------
const WORD_PACK_SUFFIXES = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, eight: 8, ten: 10, twelve: 12,
};

/**
 * Returns { baseSku, multiplier } if the SKU has a PACK suffix (multiplier ≥ 2).
 * Returns null for -1 suffix (single-unit variant label — no pack, no fix needed here).
 * Returns null if no suffix.
 */
function parsePackSuffix(sku) {
  // Numeric suffix
  const numMatch = sku.match(/^(.+)-(\d+)$/);
  if (numMatch) {
    const n = parseInt(numMatch[2], 10);
    if (n >= 2) return { baseSku: numMatch[1], multiplier: n };
    // -1 is a variant label, not a pack — skip
    return null;
  }
  // Word suffix
  const wordMatch = sku.match(/^(.+)-([a-zA-Z]+)$/);
  if (wordMatch) {
    const word = wordMatch[2].toLowerCase();
    if (word in WORD_PACK_SUFFIXES && WORD_PACK_SUFFIXES[word] >= 2) {
      return { baseSku: wordMatch[1], multiplier: WORD_PACK_SUFFIXES[word] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? '=== DRY RUN — no changes will be made ===\n' : '=== LIVE FIX ===\n');

  // 1. Load all mappings
  const mappingsResult = await db.execute(
    `SELECT marketplace_id, marketplace_sku, internal_sku FROM marketplace_item_mappings ORDER BY marketplace_sku`
  );
  const allMappings = mappingsResult.rows.map(r => ({
    marketplace_id: r.marketplace_id,
    marketplace_sku: r.marketplace_sku,
    internal_sku: r.internal_sku,
  }));

  console.log(`Total mappings in DB: ${allMappings.length}\n`);

  // 2. Find affected rows
  const affected = [];
  const clean = [];

  for (const row of allMappings) {
    const parsed = parsePackSuffix(row.internal_sku);
    if (parsed) {
      affected.push({ ...row, baseSku: parsed.baseSku, multiplier: parsed.multiplier });
    } else {
      clean.push(row);
    }
  }

  // 3. Print report
  console.log('─── AFFECTED MAPPINGS (internal_sku has pack suffix) ───────────────────────');
  if (affected.length === 0) {
    console.log('  None found — all mappings look correct!');
  } else {
    console.log(
      `  ${'marketplace_sku'.padEnd(16)} ${'internal_sku (current)'.padEnd(22)} → ${'base_sku (fix)'.padEnd(18)} multiplier`
    );
    console.log('  ' + '─'.repeat(75));
    for (const r of affected) {
      console.log(
        `  ${r.marketplace_sku.padEnd(16)} ${r.internal_sku.padEnd(22)} → ${r.baseSku.padEnd(18)} ×${r.multiplier}`
      );
    }
  }

  console.log('\n─── CLEAN MAPPINGS (no pack suffix) ────────────────────────────────────────');
  for (const r of clean) {
    console.log(`  ${r.marketplace_sku.padEnd(16)} → ${r.internal_sku}`);
  }

  if (affected.length === 0 || DRY_RUN) {
    if (DRY_RUN && affected.length > 0) {
      console.log('\nDry run complete. Re-run without --dry-run to apply fixes.');
    }
    return;
  }

  // 4. Apply fixes
  console.log('\n─── APPLYING FIXES ─────────────────────────────────────────────────────────');

  // Load existing combo recipes to avoid duplicates
  const existingCombos = await db.execute(
    `SELECT parent_combo_sku, child_inventory_sku FROM combo_product_recipes`
  );
  const existingComboSet = new Set(
    existingCombos.rows.map(r => `${r.parent_combo_sku}|${r.child_inventory_sku}`)
  );

  for (const r of affected) {
    // a. Update mapping: internal_sku → baseSku
    await db.execute({
      sql: `UPDATE marketplace_item_mappings
            SET internal_sku = ?
            WHERE marketplace_id = ? AND marketplace_sku = ?`,
      args: [r.baseSku, r.marketplace_id, r.marketplace_sku],
    });
    console.log(`  ✓ Updated mapping: ${r.marketplace_sku} → ${r.baseSku} (was ${r.internal_sku})`);

    // b. Insert combo recipe: parent=old internal_sku, child=baseSku, qty=multiplier
    //    This ensures the ingestion pipeline depletes N units of baseSku per order.
    const comboKey = `${r.internal_sku}|${r.baseSku}`;
    if (!existingComboSet.has(comboKey)) {
      await db.execute({
        sql: `INSERT OR REPLACE INTO combo_product_recipes
                (parent_combo_sku, child_inventory_sku, quantity_multiplier)
              VALUES (?, ?, ?)`,
        args: [r.internal_sku, r.baseSku, r.multiplier],
      });
      console.log(`  ✓ Added combo recipe: ${r.internal_sku} → ${r.baseSku} ×${r.multiplier}`);
      existingComboSet.add(comboKey);
    } else {
      console.log(`  ℹ Combo recipe already exists: ${r.internal_sku} → ${r.baseSku}`);
    }
  }

  // 5. Fix existing allocation rows that used the wrong physical_sku
  console.log('\n─── FIXING EXISTING ALLOCATION ROWS ────────────────────────────────────────');
  let totalAllocFixed = 0;

  for (const r of affected) {
    // Find allocations that used the suffixed SKU as physical_sku
    const allocResult = await db.execute({
      sql: `SELECT id, order_id, order_date, qty_depleted, source_marketplace_sku
            FROM order_item_allocations
            WHERE physical_sku = ?`,
      args: [r.internal_sku],
    });

    if (allocResult.rows.length === 0) {
      console.log(`  ℹ No allocation rows found for physical_sku=${r.internal_sku}`);
      continue;
    }

    console.log(`  Fixing ${allocResult.rows.length} allocation rows: ${r.internal_sku} → ${r.baseSku} (qty ×${r.multiplier})`);

    // Update: fix physical_sku and multiply qty_depleted by the pack size
    const BATCH = 100;
    const rows = allocResult.rows;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      await db.batch(
        chunk.map(row => ({
          sql: `UPDATE order_item_allocations
                SET physical_sku = ?, qty_depleted = ?
                WHERE id = ?`,
          args: [r.baseSku, Number(row.qty_depleted) * r.multiplier, row.id],
        }))
      );
    }

    totalAllocFixed += allocResult.rows.length;
    console.log(`  ✓ Fixed ${allocResult.rows.length} rows`);
  }

  // 6. Summary
  console.log('\n─── SUMMARY ─────────────────────────────────────────────────────────────────');
  console.log(`  Mappings fixed:          ${affected.length}`);
  console.log(`  Combo recipes added:     ${affected.length}`);
  console.log(`  Allocation rows fixed:   ${totalAllocFixed}`);
  console.log('\nNext steps:');
  console.log('  1. Run a manual sync to re-process recent orders with corrected mappings:');
  console.log('     POST /api/manual-sync');
  console.log('  2. Verify the restock plan reflects correct depletion quantities.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
