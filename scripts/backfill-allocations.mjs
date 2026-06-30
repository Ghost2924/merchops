/**
 * Backfill order_item_allocations from existing orders rows.
 *
 * The historical backfill (backfill-historical.mjs) wrote directly to the
 * `orders` table, bypassing the allocation pipeline. This script reads those
 * orders rows and runs them through the same mapping → combo-explosion logic
 * used by the live sync route, then writes the results to
 * `order_item_allocations`.
 *
 * Safe to re-run — deletes existing allocations for each order_id before
 * re-inserting (same idempotency strategy as upsertAllocations in queries.ts).
 *
 * Usage:
 *   node scripts/backfill-allocations.mjs                        # all orders
 *   node scripts/backfill-allocations.mjs 2025-06-01 2025-08-31  # date range
 *
 * Reads credentials from .env.local automatically.
 */

import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TURSO_URL   = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('❌  Missing env vars: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ---------------------------------------------------------------------------
// Date range from CLI args (optional)
// ---------------------------------------------------------------------------
const startDate = process.argv[2] ?? null;  // e.g. "2025-06-01"
const endDate   = process.argv[3] ?? null;  // e.g. "2025-08-31"

if ((startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) ||
    (endDate   && !/^\d{4}-\d{2}-\d{2}$/.test(endDate))) {
  console.error('❌  Dates must be YYYY-MM-DD format');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load mapping and combo tables into memory
// ---------------------------------------------------------------------------
async function buildMappingLookup() {
  const result = await db.execute(
    `SELECT marketplace_sku, internal_sku FROM marketplace_item_mappings`
  );
  const map = new Map();
  for (const r of result.rows) {
    map.set(r.marketplace_sku, r.internal_sku);
  }
  return map;
}

async function buildComboLookup() {
  const result = await db.execute(
    `SELECT parent_combo_sku, child_inventory_sku, quantity_multiplier
     FROM combo_product_recipes`
  );
  const map = new Map();
  for (const r of result.rows) {
    const list = map.get(r.parent_combo_sku) ?? [];
    list.push({
      child_inventory_sku: r.child_inventory_sku,
      quantity_multiplier: Number(r.quantity_multiplier),
    });
    map.set(r.parent_combo_sku, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Route one order row → allocation row(s)
// Mirrors buildIngestRows() in lib/db/queries.ts
//
// Rule: unmapped SKUs produce NO allocation row. The storefront financial row
// already exists in `orders`; allocation is deferred until the SKU is mapped.
// ---------------------------------------------------------------------------
function buildAllocations(orderRow, mappingLookup, comboLookup, costMap) {
  const { order_id, order_date, sku: marketplace_sku, qty } = orderRow;

  // Step 1: Route via mapping table — skip entirely if unmapped
  if (!mappingLookup.has(marketplace_sku)) {
    return { allocations: [], isUnmapped: true };
  }
  const resolvedSku = mappingLookup.get(marketplace_sku);

  // Step 2: Explode via combo recipes
  const comboComponents = comboLookup.get(resolvedSku);
  const isCombo = comboComponents !== undefined && comboComponents.length > 0;

  if (isCombo) {
    return {
      allocations: comboComponents.map((component) => {
        const unit_cost_cogs = costMap.get(component.child_inventory_sku) ?? null;
        return {
          order_id,
          order_date,
          physical_sku: component.child_inventory_sku,
          qty_depleted: qty * component.quantity_multiplier,
          source_marketplace_sku: marketplace_sku,
          unit_cost_cogs,
        };
      }),
      isUnmapped: false,
    };
  } else {
    const unit_cost_cogs = costMap.get(resolvedSku) ?? null;
    return {
      allocations: [{
        order_id,
        order_date,
        physical_sku: resolvedSku,
        qty_depleted: qty,
        source_marketplace_sku: marketplace_sku,
        unit_cost_cogs,
      }],
      isUnmapped: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Write allocations — delete-then-insert per order_id (idempotent)
// ---------------------------------------------------------------------------
const BATCH = 100;

async function writeAllocations(allocationRows) {
  if (allocationRows.length === 0) return;

  // Collect unique order_ids
  const orderIds = [...new Set(allocationRows.map((r) => r.order_id))];

  // Delete stale allocations for these orders
  for (let i = 0; i < orderIds.length; i += BATCH) {
    const chunk = orderIds.slice(i, i + BATCH);
    const placeholders = chunk.map(() => '?').join(',');
    await db.execute({
      sql: `DELETE FROM order_item_allocations WHERE order_id IN (${placeholders})`,
      args: chunk,
    });
  }

  // Insert fresh allocations
  for (let i = 0; i < allocationRows.length; i += BATCH) {
    const chunk = allocationRows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO order_item_allocations
                (order_id, order_date, physical_sku, qty_depleted, source_marketplace_sku, unit_cost_cogs)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [r.order_id, r.order_date, r.physical_sku, r.qty_depleted, r.source_marketplace_sku, r.unit_cost_cogs ?? null],
      }))
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n📦  Backfill order_item_allocations from orders table');

  // Build lookup tables
  const [mappingLookup, comboLookup] = await Promise.all([
    buildMappingLookup(),
    buildComboLookup(),
  ]);
  console.log(`    Mappings loaded : ${mappingLookup.size}`);
  console.log(`    Combo SKUs loaded: ${comboLookup.size}`);

  // Load cost map for COGS snapshotting (empty map if unit_cost column not yet present)
  let costMap = new Map();
  try {
    const costResult = await db.execute(
      `SELECT sku, unit_cost FROM inventory WHERE unit_cost IS NOT NULL`
    );
    for (const r of costResult.rows) {
      const sku = r.sku;
      const cost = Number(r.unit_cost);
      costMap.set(sku, cost);
      if (sku.startsWith('AM-')) costMap.set('AM' + sku.slice(3), cost);
    }
    console.log(`    Cost entries loaded: ${costMap.size}`);
  } catch {
    console.log('    unit_cost column not yet present — COGS will be NULL on allocation rows');
  }

  // Fetch orders in date range (or all)
  let sql = `SELECT order_id, order_date, sku, qty FROM orders`;
  const args = [];
  if (startDate && endDate) {
    sql += ` WHERE order_date >= ? AND order_date <= ?`;
    args.push(startDate, endDate);
    console.log(`    Date range      : ${startDate} → ${endDate}`);
  } else if (startDate) {
    sql += ` WHERE order_date >= ?`;
    args.push(startDate);
    console.log(`    Date range      : ${startDate} → (all)`);
  } else {
    console.log(`    Date range      : all`);
  }
  sql += ` ORDER BY order_date ASC`;

  const ordersResult = await db.execute({ sql, args });
  const orderRows = ordersResult.rows;
  console.log(`    Orders to process: ${orderRows.length}\n`);

  if (orderRows.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  // Check existing allocation count before
  const before = await db.execute('SELECT COUNT(*) as cnt FROM order_item_allocations');
  console.log(`    Allocations before: ${before.rows[0].cnt}`);

  // Process in chunks of 500 orders to keep memory low and show progress
  const CHUNK = 500;
  let totalAllocations = 0;
  let unmappedSkus = new Set();
  let skippedUnmapped = 0;

  for (let i = 0; i < orderRows.length; i += CHUNK) {
    const chunk = orderRows.slice(i, i + CHUNK);
    const allocationRows = [];

    for (const row of chunk) {
      const { allocations, isUnmapped } = buildAllocations(row, mappingLookup, comboLookup, costMap);
      if (isUnmapped) {
        unmappedSkus.add(row.sku);
        skippedUnmapped++;
      } else {
        allocationRows.push(...allocations);
      }
    }

    await writeAllocations(allocationRows);
    totalAllocations += allocationRows.length;

    const pct = Math.round(((i + chunk.length) / orderRows.length) * 100);
    process.stdout.write(`\r    Progress: ${i + chunk.length}/${orderRows.length} orders (${pct}%) → ${totalAllocations} allocations written`);
  }

  // Final summary
  const after = await db.execute('SELECT COUNT(*) as cnt FROM order_item_allocations');
  console.log(`\n\n${'─'.repeat(60)}`);
  console.log(`✅  Done!`);
  console.log(`    Orders processed   : ${orderRows.length.toLocaleString()}`);
  console.log(`    Allocations written: ${totalAllocations.toLocaleString()}`);
  console.log(`    Allocations in DB  : ${after.rows[0].cnt}`);
  if (skippedUnmapped > 0) {
    console.log(`    Skipped (unmapped) : ${skippedUnmapped} order rows — no allocation written`);
  }

  if (unmappedSkus.size > 0) {
    console.log(`\n⚠   ${unmappedSkus.size} SKU(s) had no mapping — allocation rows skipped:`);
    for (const sku of [...unmappedSkus].slice(0, 20)) {
      console.log(`      ${sku}`);
    }
    if (unmappedSkus.size > 20) {
      console.log(`      ... and ${unmappedSkus.size - 20} more`);
    }
    console.log(`\n    Fix mappings in marketplace_item_mappings, then re-run this script.`);
  }
}

main().catch((err) => {
  console.error('\n💥  Fatal:', err.message);
  process.exit(1);
});
