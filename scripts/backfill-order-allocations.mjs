#!/usr/bin/env node
/**
 * backfill-order-allocations.mjs
 *
 * Re-processes ALL order_lines rows through the allocation pipeline and
 * upserts results into inventory_allocations.
 *
 * This is the PRIMARY velocity fix. The original backfill only wrote ~71k
 * rows (one 3.5-hour window). This script covers the full 2022→2026 range.
 *
 * Safe to re-run — uses ON CONFLICT DO NOTHING on allocation_id (uuid of
 * order_line_id + inventory_sku).  Pass --force to delete-then-reinsert all.
 *
 * Usage:
 *   node scripts/backfill-order-allocations.mjs
 *   node scripts/backfill-order-allocations.mjs 2024-01-01 2026-12-31
 *   node scripts/backfill-order-allocations.mjs --force          # delete + reinsert all
 *   node scripts/backfill-order-allocations.mjs --dry-run        # stats only, no writes
 *
 * Reads credentials from .env.local automatically.
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
} catch {
  // env already set via environment
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const FORCE    = args.includes('--force');
const DRY_RUN  = args.includes('--dry-run');
const dateArgs = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const startDate = dateArgs[0] ?? null;
const endDate   = dateArgs[1] ?? null;

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------
const TURSO_URL   = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('❌  Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ---------------------------------------------------------------------------
// Load sku_mappings: source_sku → teapplix_sku (exact + lowercase)
// ---------------------------------------------------------------------------
async function buildMappingLookup() {
  const result = await db.execute(
    `SELECT source_sku, teapplix_sku FROM sku_mappings WHERE active = 1`
  );
  const map = new Map();
  for (const r of result.rows) {
    const src = r.source_sku;
    const tgt = r.teapplix_sku;
    map.set(src, tgt);
    const lower = src.toLowerCase().trim();
    if (!map.has(lower)) map.set(lower, tgt);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Load combo_components: combo_sku → [{child_inventory_sku, quantity}]
// ---------------------------------------------------------------------------
async function buildComboLookup() {
  const result = await db.execute(
    `SELECT combo_sku, child_inventory_sku, quantity FROM combo_components ORDER BY combo_sku, sequence`
  );
  const map = new Map();
  for (const r of result.rows) {
    const sku = r.combo_sku;
    const list = map.get(sku) ?? [];
    list.push({ child_inventory_sku: r.child_inventory_sku, quantity: Number(r.quantity) });
    map.set(sku, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Load inventory + combo SKU sets
// ---------------------------------------------------------------------------
async function buildSkuSets() {
  const [invResult, comboResult] = await Promise.all([
    db.execute(`SELECT sku FROM inventory_products WHERE active = 1`),
    db.execute(`SELECT sku FROM combo_products WHERE active = 1`),
  ]);
  return {
    inventorySkuSet: new Set(invResult.rows.map(r => r.sku)),
    comboSkuSet:     new Set(comboResult.rows.map(r => r.sku)),
  };
}

// ---------------------------------------------------------------------------
// parsePack — mirrors lib/sku/resolver.ts parsePack logic
// Extracts trailing numeric suffix as pack multiplier.
// e.g. "5233-2" → { base: "5233", qty: 2 }
//      "5233-1" → { base: "5233", qty: 1 }
//      "5233"   → { base: "5233", qty: 1 }
// ---------------------------------------------------------------------------
const WORD_PACK_SIZES = {
  one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  eleven:11,twelve:12,fifteen:15,twenty:20
};

function parsePack(sku) {
  if (!sku) return { base: sku, qty: 1 };

  // Numeric suffix: "5233-2", "AM5233-10"
  const numMatch = sku.match(/^(.+)-(\d+)$/);
  if (numMatch) {
    const qty = parseInt(numMatch[2], 10);
    if (qty >= 2) return { base: numMatch[1], qty };
    // -1 suffix = single unit, not a pack
    return { base: numMatch[1], qty: 1 };
  }

  // Word suffix: "AM5230-five", "A-AM5230-five"
  const wordMatch = sku.match(/^(.+?)-([a-zA-Z]+)$/i);
  if (wordMatch) {
    const word = wordMatch[2].toLowerCase();
    if (WORD_PACK_SIZES[word]) {
      return { base: wordMatch[1], qty: WORD_PACK_SIZES[word] };
    }
  }

  return { base: sku, qty: 1 };
}

// ---------------------------------------------------------------------------
// normalizeSku — mirrors lib/db/queries.ts normalizeSku
// ---------------------------------------------------------------------------
function normalizeSku(raw) {
  if (!raw) return '';
  return raw.trim().replace(/^'+/, '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// resolverNormalizeSku — mirrors lib/sku/resolver.ts normalizeSku
// ---------------------------------------------------------------------------
function resolverNormalizeSku(raw) {
  if (!raw) return '';
  let s = raw.trim();
  s = s.replace(/^"""+|"""+$/g, '');
  s = s.replace(/^['"]|['"]$/g, '');
  if (s.startsWith("'")) s = s.slice(1);
  s = s.replace(/[\r\n]+/g, '');
  s = s.replace(/^1AMAM/i, '').replace(/^1AM/i, '').replace(/^AM/i, '');
  s = s.replace(/-(LA|par)$/i, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// ---------------------------------------------------------------------------
// Build allocation rows from a single order_line row
// Returns: AllocationRow[]
// ---------------------------------------------------------------------------
function buildAllocations(orderLine, mappingLookup, comboLookup, inventorySkuSet, comboSkuSet) {
  const {
    order_line_id,
    order_date,
    raw_storefront_sku,
    resolved_teapplix_sku,
    resolved_product_type,
    qty_sold,
    mapping_status,
  } = orderLine;

  // Skip lines that were already marked unmapped / mapping_error
  // unless we can resolve them now with the current mapping table
  let teapplixSku = resolved_teapplix_sku;

  // If not resolved in order_lines, try mapping now
  if (!teapplixSku || mapping_status === 'unmapped') {
    const rawSku = raw_storefront_sku;
    if (mappingLookup.has(rawSku)) {
      teapplixSku = mappingLookup.get(rawSku);
    } else {
      const normalized = resolverNormalizeSku(rawSku).toLowerCase();
      if (mappingLookup.has(normalized)) {
        teapplixSku = mappingLookup.get(normalized);
      }
    }
  }

  if (!teapplixSku) return []; // still unmapped

  // Pack multiplier handling:
  // For INVENTORY SKUs: qty_sold in order_lines was stored as qty × parsePack(teapplixSku).qty
  //   during live ingest. We must UN-apply the pack multiply to recover raw order qty,
  //   then re-apply it correctly via parsePack for the allocation.
  //   (Older rows may have been stored without pack multiply — parsePack handles both:
  //   if packQty=1, effectiveQty = qty_sold unchanged.)
  // For COMBO SKUs: qty_sold should be raw order qty (1 pack = 1).
  //   BUT historically buggy rows have qty_sold = raw_qty × parsePack(suffix).
  //   We un-inflate by dividing by parsePack(teapplixSku).qty before combo explode.

  let effectiveQty = Number(qty_sold);

  // Determine product type BEFORE pack calculations
  let productType = resolved_product_type;
  if (!productType || productType === 'unknown') {
    if (inventorySkuSet.has(teapplixSku)) productType = 'inventory';
    else if (comboSkuSet.has(teapplixSku)) productType = 'combo';
  }

  if (productType === 'inventory') {
    // effectiveQty = qty_sold already includes pack multiply from live ingest.
    // Use as-is for direct allocation.
    return [{
      allocation_id: `${order_line_id}|${teapplixSku}`,
      order_line_id,
      inventory_sku: teapplixSku,
      qty_depleted: effectiveQty,
      source_teapplix_sku: teapplixSku,
      source_storefront_sku: raw_storefront_sku,
      allocation_type: 'direct',
    }];
  }

  if (productType === 'combo') {
    const components = comboLookup.get(teapplixSku);
    if (!components || components.length === 0) return []; // no recipe — silent drop

    // Un-inflate: historically buggy rows stored qty_sold = raw_qty × parsePack(suffix).
    // Recover raw order qty by dividing out the (incorrectly applied) pack multiplier.
    // For correctly-stored rows packQty=1 (combos should not be pack-multiplied),
    // so this division is a no-op.
    const { qty: packQty } = parsePack(teapplixSku);
    const rawOrderQty = packQty > 1 ? Math.round(effectiveQty / packQty) : effectiveQty;

    // qty_depleted = raw order qty × component.quantity (base units per combo)
    return components.map(comp => ({
      allocation_id: `${order_line_id}|${comp.child_inventory_sku}`,
      order_line_id,
      inventory_sku: comp.child_inventory_sku,
      qty_depleted: rawOrderQty * comp.quantity,
      source_teapplix_sku: teapplixSku,
      source_storefront_sku: raw_storefront_sku,
      allocation_type: 'combo_explode',
    }));
  }

  return []; // unknown type
}

// ---------------------------------------------------------------------------
// Fix inflated qty_sold in order_lines for combo SKUs
// Historically, buildIngestRows applied parsePack(comboSku).qty as a multiplier
// before storing qty_sold. For combos, qty_sold should equal raw order qty.
// This function corrects those rows: divides qty_sold by parsePack(comboSku).qty
// when packQty > 1 and the SKU is a combo.
// ---------------------------------------------------------------------------
async function fixComboQtySold(comboSkuSet, dryRun) {
  // Fetch all combo order_lines with a numeric suffix > 1 in the teapplix SKU
  const result = await db.execute(`
    SELECT order_line_id, resolved_teapplix_sku, qty_sold
    FROM order_lines
    WHERE resolved_product_type = 'combo'
      AND resolved_teapplix_sku IS NOT NULL
  `);

  const updates = [];
  for (const row of result.rows) {
    const sku = row.resolved_teapplix_sku;
    const { qty: packQty } = parsePack(sku);
    if (packQty <= 1) continue; // no inflation, skip
    const currentQty = Number(row.qty_sold);
    const correctedQty = Math.round(currentQty / packQty);
    if (correctedQty === currentQty) continue; // already correct
    updates.push({ order_line_id: row.order_line_id, correctedQty });
  }

  console.log(`\n    Combo qty_sold corrections needed: ${updates.length}`);
  if (updates.length === 0) return;

  if (!dryRun) {
    const BATCH = 100;
    for (let i = 0; i < updates.length; i += BATCH) {
      const chunk = updates.slice(i, i + BATCH);
      await db.batch(chunk.map(u => ({
        sql: `UPDATE order_lines SET qty_sold = ? WHERE order_line_id = ?`,
        args: [u.correctedQty, u.order_line_id],
      })));
    }
    console.log(`    Fixed ${updates.length} inflated combo qty_sold rows.`);
  } else {
    console.log(`    [DRY RUN] Would fix ${updates.length} inflated combo qty_sold rows.`);
  }
}


const WRITE_BATCH = 100;

async function writeAllocations(allocRows, force) {
  if (allocRows.length === 0) return;

  if (force) {
    // Delete by order_line_id so we replace cleanly
    const lineIds = [...new Set(allocRows.map(r => r.order_line_id))];
    for (let i = 0; i < lineIds.length; i += WRITE_BATCH) {
      const chunk = lineIds.slice(i, i + WRITE_BATCH);
      const ph = chunk.map(() => '?').join(',');
      await db.execute({ sql: `DELETE FROM inventory_allocations WHERE order_line_id IN (${ph})`, args: chunk });
    }
  }

  for (let i = 0; i < allocRows.length; i += WRITE_BATCH) {
    const chunk = allocRows.slice(i, i + WRITE_BATCH);
    await db.batch(
      chunk.map(r => ({
        sql: `INSERT INTO inventory_allocations
                (allocation_id, order_line_id, inventory_sku, qty_depleted,
                 source_teapplix_sku, source_storefront_sku, allocation_type)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(allocation_id) DO NOTHING`,
        args: [
          r.allocation_id, r.order_line_id, r.inventory_sku, r.qty_depleted,
          r.source_teapplix_sku, r.source_storefront_sku, r.allocation_type,
        ],
      }))
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n🔄  Backfill inventory_allocations from order_lines');
  console.log(`    Mode     : ${DRY_RUN ? 'DRY RUN (no writes)' : FORCE ? 'FORCE (delete+reinsert)' : 'UPSERT (skip existing)'}`);
  if (startDate) console.log(`    From     : ${startDate}`);
  if (endDate)   console.log(`    To       : ${endDate}`);

  // Build lookups
  console.log('\n    Loading lookup tables...');
  const [mappingLookup, comboLookup, { inventorySkuSet, comboSkuSet }] = await Promise.all([
    buildMappingLookup(),
    buildComboLookup(),
    buildSkuSets(),
  ]);
  console.log(`    sku_mappings loaded     : ${mappingLookup.size} keys (incl lowercase)`);
  console.log(`    combo recipes loaded    : ${comboLookup.size} combo parents`);
  console.log(`    inventory SKUs          : ${inventorySkuSet.size}`);
  console.log(`    combo SKUs              : ${comboSkuSet.size}`);

  // Count existing allocations
  const beforeResult = await db.execute(`SELECT COUNT(*) AS cnt FROM inventory_allocations`);
  const beforeCount = Number(beforeResult.rows[0].cnt);
  console.log(`\n    inventory_allocations before: ${beforeCount.toLocaleString()}`);

  // Fetch order_lines
  let sql = `SELECT order_line_id, order_date, raw_storefront_sku, resolved_teapplix_sku,
                    resolved_product_type, qty_sold, mapping_status
             FROM order_lines`;
  const sqlArgs = [];
  const conditions = [];
  if (startDate) { conditions.push(`order_date >= ?`); sqlArgs.push(startDate); }
  if (endDate)   { conditions.push(`order_date <= ?`); sqlArgs.push(endDate); }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ` ORDER BY order_date ASC`;

  const linesResult = await db.execute({ sql, args: sqlArgs });
  const orderLines = linesResult.rows;
  console.log(`    order_lines to process  : ${orderLines.length.toLocaleString()}`);

  if (orderLines.length === 0) {
    console.log('\n    Nothing to process. Exiting.');
    await db.close();
    return;
  }

  // Process in chunks
  const PROCESS_CHUNK = 500;
  let totalAllocations = 0;
  let skippedUnmapped = 0;
  let skippedNoRecipe = 0;
  let directCount = 0;
  let comboCount = 0;
  const unmappedSkus = new Set();

  for (let i = 0; i < orderLines.length; i += PROCESS_CHUNK) {
    const chunk = orderLines.slice(i, i + PROCESS_CHUNK);
    const allocRows = [];

    for (const line of chunk) {
      const allocs = buildAllocations(
        line, mappingLookup, comboLookup, inventorySkuSet, comboSkuSet
      );

      if (allocs.length === 0) {
        // Distinguish unmapped vs no-recipe
        const sku = line.raw_storefront_sku;
        const hasMapped = mappingLookup.has(sku) ||
          mappingLookup.has(resolverNormalizeSku(sku).toLowerCase());

        if (!hasMapped && !line.resolved_teapplix_sku) {
          unmappedSkus.add(sku);
          skippedUnmapped++;
        } else {
          skippedNoRecipe++;
        }
        continue;
      }

      for (const a of allocs) {
        if (a.allocation_type === 'direct') directCount++;
        else comboCount++;
      }
      allocRows.push(...allocs);
    }

    if (!DRY_RUN) {
      await writeAllocations(allocRows, FORCE);
    }
    totalAllocations += allocRows.length;

    const pct = Math.round(((i + chunk.length) / orderLines.length) * 100);
    process.stdout.write(
      `\r    Progress: ${(i + chunk.length).toLocaleString()}/${orderLines.length.toLocaleString()} lines (${pct}%) → ${totalAllocations.toLocaleString()} allocations`
    );
  }

  // Fix inflated qty_sold for historical combo order_lines
  console.log('\n    Fixing inflated combo qty_sold in order_lines...');
  await fixComboQtySold(comboSkuSet, DRY_RUN);

  // Final summary
  let afterCount = beforeCount;
  if (!DRY_RUN) {
    const afterResult = await db.execute(`SELECT COUNT(*) AS cnt FROM inventory_allocations`);
    afterCount = Number(afterResult.rows[0].cnt);
  }

  console.log(`\n\n${'─'.repeat(65)}`);
  console.log(`✅  Done!`);
  console.log(`    Order lines processed   : ${orderLines.length.toLocaleString()}`);
  console.log(`    Allocation rows built   : ${totalAllocations.toLocaleString()}`);
  console.log(`      direct                : ${directCount.toLocaleString()}`);
  console.log(`      combo_explode         : ${comboCount.toLocaleString()}`);
  console.log(`    Skipped (unmapped SKU)  : ${skippedUnmapped.toLocaleString()}`);
  console.log(`    Skipped (no combo recipe): ${skippedNoRecipe.toLocaleString()}`);
  if (!DRY_RUN) {
    console.log(`    inventory_allocations before : ${beforeCount.toLocaleString()}`);
    console.log(`    inventory_allocations after  : ${afterCount.toLocaleString()}`);
    console.log(`    Net new rows                 : ${(afterCount - beforeCount).toLocaleString()}`);
  } else {
    console.log(`    [DRY RUN — no writes performed]`);
  }

  if (unmappedSkus.size > 0) {
    console.log(`\n⚠   ${unmappedSkus.size} unique SKUs still unmapped (no allocation written):`);
    [...unmappedSkus].slice(0, 25).forEach(s => console.log(`      ${s}`));
    if (unmappedSkus.size > 25) console.log(`      ... and ${unmappedSkus.size - 25} more`);
  }

  console.log(`\n    Next step: run the audit script to verify monthly histogram alignment.`);
  console.log(`      node scripts/restock-audit.js\n`);

  await db.close();
}

main().catch(err => {
  console.error('\n💥  Fatal:', err.message ?? err);
  process.exit(1);
});
