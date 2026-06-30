#!/usr/bin/env node
/**
 * backfill-combo-recipes.mjs
 *
 * Root cause #2 fix: populate combo_components for the 683 combo SKUs
 * that have no recipe entry.
 *
 * Strategy: combo SKUs follow the pattern <base_sku>-<qty>
 *   e.g.  5003-24CC-2  →  base=5003-24CC  qty=2  (sells 2× of 5003-24CC per order)
 *         5003-24CC-4  →  base=5003-24CC  qty=4
 *         AM5230-five  →  base=AM5230     qty=5  (word pack)
 *
 * The child inventory SKU is the base SKU itself (or base-1 if that variant exists).
 *
 * Steps:
 *   1. Load all combo_products with no existing combo_components rows.
 *   2. For each: strip the -N suffix → look up base in inventory_products.
 *      Also try base + "-1" (some base units are stored as <sku>-1).
 *      Also try case-insensitive match.
 *   3. Insert resolved rows into combo_components.
 *   4. Log unresolvable combos — these need manual recipe data.
 *
 * Safe to re-run (ON CONFLICT DO NOTHING).
 *
 * Usage:
 *   node scripts/backfill-combo-recipes.mjs
 *   node scripts/backfill-combo-recipes.mjs --dry-run
 *   node scripts/backfill-combo-recipes.mjs --all       # re-process even existing recipes
 */

import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------
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
} catch { /* env set externally */ }

const args = process.argv.slice(2);
const DRY_RUN     = args.includes('--dry-run');
const PROCESS_ALL = args.includes('--all');

const TURSO_URL   = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('❌  Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN');
  process.exit(1);
}
const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ---------------------------------------------------------------------------
// Word pack sizes — mirrors lib/sku/resolver.ts
// ---------------------------------------------------------------------------
const WORD_PACK_SIZES = {
  one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  eleven:11,twelve:12,fifteen:15,twenty:20
};

/**
 * Parse combo SKU into { base, qty }.
 * Returns null if no recognizable pack suffix.
 */
function parseComboSku(sku) {
  // Numeric suffix: 5003-24CC-2 → base=5003-24CC qty=2
  const numMatch = sku.match(/^(.+)-(\d+)$/);
  if (numMatch) {
    const qty = parseInt(numMatch[2], 10);
    if (qty >= 2) return { base: numMatch[1], qty };
    if (qty === 1) return { base: numMatch[1], qty: 1 }; // explicit -1 = single unit combo
  }

  // Word suffix: AM5230-five → base=AM5230 qty=5
  const wordMatch = sku.match(/^(.+?)-([a-zA-Z]+)$/i);
  if (wordMatch) {
    const word = wordMatch[2].toLowerCase();
    if (WORD_PACK_SIZES[word]) return { base: wordMatch[1], qty: WORD_PACK_SIZES[word] };
  }

  return null; // no suffix → can't auto-derive
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n🔧  Backfill combo_components from combo SKU naming convention');
  console.log(`    Mode: ${DRY_RUN ? 'DRY RUN' : 'WRITE'} | Scope: ${PROCESS_ALL ? 'ALL combos' : 'combos with no existing recipes'}`);

  // Load all inventory SKUs — canonical + lowercase index
  const invResult = await db.execute(`SELECT sku FROM inventory_products WHERE active = 1`);
  const invSkus = new Set(invResult.rows.map(r => r.sku));
  const invLower = new Map(); // lowercase → canonical
  for (const sku of invSkus) invLower.set(sku.toLowerCase(), sku);

  console.log(`    inventory SKUs loaded: ${invSkus.size}`);

  // Load combo SKUs that need recipes
  let comboQuery;
  if (PROCESS_ALL) {
    comboQuery = await db.execute(`SELECT sku FROM combo_products WHERE active = 1`);
  } else {
    // Only combos with ZERO component rows
    comboQuery = await db.execute(`
      SELECT cp.sku
      FROM combo_products cp
      WHERE cp.active = 1
        AND NOT EXISTS (
          SELECT 1 FROM combo_components cc WHERE cc.combo_sku = cp.sku
        )
    `);
  }
  const targetCombos = comboQuery.rows.map(r => r.sku);
  console.log(`    Combos to process    : ${targetCombos.length}`);

  const toInsert   = []; // { combo_sku, child_inventory_sku, quantity }
  const resolved   = [];
  const unresolved = [];

  for (const comboSku of targetCombos) {
    const parsed = parseComboSku(comboSku);
    if (!parsed) {
      unresolved.push({ sku: comboSku, reason: 'no_pack_suffix' });
      continue;
    }

    const { base, qty } = parsed;

    // Resolution order:
    // 1. base exact
    // 2. base + "-1" (some base units stored as <sku>-1)
    // 3. base case-insensitive
    // 4. base + "-1" case-insensitive
    let childSku = null;
    if (invSkus.has(base)) {
      childSku = base;
    } else if (invSkus.has(base + '-1')) {
      childSku = base + '-1';
    } else {
      const baseLower = base.toLowerCase();
      if (invLower.has(baseLower)) {
        childSku = invLower.get(baseLower);
      } else if (invLower.has(baseLower + '-1')) {
        childSku = invLower.get(baseLower + '-1');
      }
    }

    if (childSku) {
      toInsert.push({ combo_sku: comboSku, child_inventory_sku: childSku, quantity: qty });
      resolved.push({ combo_sku: comboSku, child: childSku, qty });
    } else {
      unresolved.push({ sku: comboSku, reason: `base_not_found: ${base}` });
    }
  }

  console.log(`\n    Resolvable   : ${resolved.length}`);
  console.log(`    Unresolvable : ${unresolved.length}`);

  if (!DRY_RUN && toInsert.length > 0) {
    const BATCH = 100;
    let inserted = 0;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const chunk = toInsert.slice(i, i + BATCH);
      await db.batch(
        chunk.map(r => ({
          sql: `INSERT INTO combo_components (combo_sku, child_inventory_sku, quantity, sequence)
                VALUES (?, ?, ?, 1)
                ON CONFLICT(combo_sku, child_inventory_sku) DO UPDATE SET
                  quantity = excluded.quantity`,
          args: [r.combo_sku, r.child_inventory_sku, r.quantity],
        }))
      );
      inserted += chunk.length;
    }
    console.log(`\n    ✅  Inserted ${inserted} recipe rows into combo_components`);
  } else if (DRY_RUN) {
    console.log(`\n    [DRY RUN — no writes]`);
    console.log('    Sample resolved:');
    resolved.slice(0, 10).forEach(r => console.log(`      ${r.combo_sku} → child=${r.child} qty=${r.qty}`));
  }

  // Verify new total
  if (!DRY_RUN) {
    const countResult = await db.execute(`SELECT COUNT(DISTINCT combo_sku) AS n FROM combo_components`);
    console.log(`\n    combo_products with recipes now: ${countResult.rows[0].n}`);
  }

  // Report unresolvable
  if (unresolved.length > 0) {
    console.log(`\n${'─'.repeat(65)}`);
    console.log(`⚠   ${unresolved.length} combos could not be auto-resolved:`);
    console.log(`    These need manual recipes in combo_components.\n`);

    // Group by reason
    const byReason = {};
    for (const u of unresolved) {
      const key = u.reason.startsWith('base_not_found') ? 'base_not_found' : u.reason;
      byReason[key] = byReason[key] ?? [];
      byReason[key].push(u.sku);
    }

    for (const [reason, skus] of Object.entries(byReason)) {
      console.log(`\n  Reason: ${reason} (${skus.length} combos)`);
      skus.slice(0, 30).forEach(s => console.log(`    ${s}`));
      if (skus.length > 30) console.log(`    ... and ${skus.length - 30} more`);
    }

    console.log(`\n  To add recipes manually:`);
    console.log(`    INSERT INTO combo_components (combo_sku, child_inventory_sku, quantity, sequence)`);
    console.log(`    VALUES ('<combo_sku>', '<child_sku>', <qty_per_unit>, 1);`);
    console.log(`\n  To add recipes from a CSV (columns: combo_sku,child_sku,quantity):`);
    console.log(`    node scripts/seed-product-catalog.mjs  (after updating comboproducts.csv)`);
  }

  console.log(`\n    Next: re-run backfill-order-allocations.mjs to pick up new combo routes.`);
  console.log(`      node scripts/backfill-order-allocations.mjs --force\n`);

  await db.close();
}

main().catch(err => {
  console.error('\n💥  Fatal:', err.message ?? err);
  process.exit(1);
});
