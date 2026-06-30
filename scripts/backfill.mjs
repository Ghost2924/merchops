/**
 * One-shot backfill script: re-syncs the last N days from Teapplix
 * using the deterministic Parent-Child Relational Mapping pipeline.
 *
 * Usage:
 *   node scripts/backfill.mjs [days=30]
 *
 * Reads env from .env.local automatically.
 *
 * Pipeline per order item:
 *   1. Route: marketplace_sku → internal_sku via marketplace_item_mappings
 *      (falls back to raw SKU if no mapping; logs to unmapped_skus)
 *   2. Explode: if resolved SKU is a parent_combo_sku in combo_product_recipes,
 *      write child allocation rows. Otherwise write 1:1 allocation.
 *   3. Write: orders (storefront financial) + order_item_allocations (physical)
 */

import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

// ---------------------------------------------------------------------------
// Load .env.local manually (no dotenv dependency needed)
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
const DAYS = parseInt(process.argv[2] ?? '30', 10);
const BASE = 'https://api.teapplix.com/api2';
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const TEAPPLIX_TOKEN = process.env.TEAPPLIX_API_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN || !TEAPPLIX_TOKEN) {
  console.error('Missing env vars: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, TEAPPLIX_API_TOKEN');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ---------------------------------------------------------------------------
// Load mapping and combo tables from DB
// ---------------------------------------------------------------------------

/** Returns Map<marketplace_sku, internal_sku> */
async function loadMappingLookup() {
  const result = await db.execute(
    `SELECT marketplace_sku, internal_sku FROM marketplace_item_mappings`
  );
  const map = new Map();
  for (const r of result.rows) {
    map.set(r.marketplace_sku, r.internal_sku);
  }
  return map;
}

/** Returns Map<parent_combo_sku, [{child_inventory_sku, quantity_multiplier}]> */
async function loadComboLookup() {
  const result = await db.execute(
    `SELECT parent_combo_sku, child_inventory_sku, quantity_multiplier FROM combo_product_recipes`
  );
  const map = new Map();
  for (const r of result.rows) {
    const list = map.get(r.parent_combo_sku) ?? [];
    list.push({ child_inventory_sku: r.child_inventory_sku, quantity_multiplier: Number(r.quantity_multiplier) });
    map.set(r.parent_combo_sku, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Deterministic ingestion pipeline (mirrors lib/db/queries.ts buildIngestRows)
// ---------------------------------------------------------------------------

/**
 * Route + explode a single order item.
 * Returns { orderRow, allocationRows, isUnmapped }.
 *
 * Rule: unmapped SKUs get NO allocation row — the storefront financial row
 * is still written so revenue is preserved, but physical depletion is
 * deferred until the SKU is mapped and a re-sync is run.
 */
function processItem({ marketplace_sku, order_id, order_date, qty, total_price, line_number }, mappingLookup, comboLookup, costMap) {
  // Step 1: Route
  let resolvedSku = null;
  let isUnmapped = false;
  if (mappingLookup.has(marketplace_sku)) {
    resolvedSku = mappingLookup.get(marketplace_sku);
  } else {
    isUnmapped = true;
  }

  const unit_price = qty > 0 ? Math.round((total_price / qty) * 100) / 100 : 0;

  // Stable order_id: include line_number to prevent collision
  const stableOrderId = `${order_id}|${line_number}`;

  const orderRow = {
    order_id: stableOrderId,
    order_date,
    sku: marketplace_sku, // storefront SKU preserved
    resolved_sku: resolvedSku,
    qty,
    unit_price,
    total_price: Math.round(total_price * 100) / 100,
    is_combo: 0,
  };

  if (isUnmapped) {
    // No allocation row for unmapped SKUs — avoids polluting the warehouse DB
    return { orderRow, allocationRows: [], isUnmapped: true };
  }

  // Step 2: Explode
  const comboComponents = comboLookup.get(resolvedSku);
  const isCombo = comboComponents !== undefined && comboComponents.length > 0;
  orderRow.is_combo = isCombo ? 1 : 0;

  const allocationRows = [];
  if (isCombo) {
    for (const component of comboComponents) {
      const unit_cost_cogs = costMap.get(component.child_inventory_sku) ?? null;
      allocationRows.push({
        order_id: stableOrderId,
        order_date,
        physical_sku: component.child_inventory_sku,
        qty_depleted: qty * component.quantity_multiplier,
        source_marketplace_sku: marketplace_sku,
        unit_cost_cogs,
      });
    }
  } else {
    const unit_cost_cogs = costMap.get(resolvedSku) ?? null;
    allocationRows.push({
      order_id: stableOrderId,
      order_date,
      physical_sku: resolvedSku,
      qty_depleted: qty,
      source_marketplace_sku: marketplace_sku,
      unit_cost_cogs,
    });
  }

  return { orderRow, allocationRows, isUnmapped: false };
}

// ---------------------------------------------------------------------------
// Teapplix fetch with retry
// ---------------------------------------------------------------------------
async function fetchWithRetry(url, attempt = 1) {
  const res = await fetch(url, { headers: { APIToken: TEAPPLIX_TOKEN } });
  if ((res.status === 503 || res.status === 429) && attempt < 5) {
    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
    console.warn(`  [retry] ${res.status}, waiting ${delay}ms...`);
    await new Promise((r) => setTimeout(r, delay));
    return fetchWithRetry(url, attempt + 1);
  }
  return res;
}

async function fetchOrdersForDate(dateStr) {
  const allOrders = [];
  let seqStart = null;

  while (true) {
    const url = new URL(`${BASE}/OrderNotification`);
    url.searchParams.set('PaymentDateStart', dateStr);
    url.searchParams.set('PaymentDateEnd', dateStr);
    if (seqStart !== null) url.searchParams.set('SeqStart', String(seqStart));

    const res = await fetchWithRetry(url.toString());
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Teapplix ${res.status}: ${body}`);
    }

    const data = await res.json();
    const orders = data.Orders ?? [];
    allOrders.push(...orders);

    const p = data.Pagination;
    if (p && p.PageNumber < p.TotalPages) {
      seqStart = parseInt(orders[orders.length - 1].SeqNumber, 10) + 1;
    } else {
      break;
    }
  }
  return allOrders;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function dateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.BUSINESS_TIMEZONE ?? 'America/Los_Angeles',
  }).format(d);
}

function buildDateRange(days) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    dates.push(dateNDaysAgo(i));
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Upsert helpers
// ---------------------------------------------------------------------------
async function upsertOrderRows(rows) {
  if (rows.length === 0) return;
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT OR REPLACE INTO orders
                (order_id, order_date, sku, resolved_sku, qty, unit_price, total_price, is_combo)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [r.order_id, r.order_date, r.sku, r.resolved_sku ?? null, r.qty, r.unit_price, r.total_price, r.is_combo],
      }))
    );
  }
}

async function upsertAllocationRows(rows) {
  if (rows.length === 0) return;

  // Delete stale allocations for these order_ids first
  const orderIds = [...new Set(rows.map((r) => r.order_id))];
  const DEL_BATCH = 100;
  for (let i = 0; i < orderIds.length; i += DEL_BATCH) {
    const chunk = orderIds.slice(i, i + DEL_BATCH);
    const placeholders = chunk.map(() => '?').join(',');
    await db.execute({
      sql: `DELETE FROM order_item_allocations WHERE order_id IN (${placeholders})`,
      args: chunk,
    });
  }

  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
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

async function recordUnmappedSkus(skus, dateStr) {
  if (skus.length === 0) return;
  for (const sku of skus) {
    await db.execute({
      sql: `INSERT INTO unmapped_skus (marketplace_sku, first_seen, last_seen, occurrence_count)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(marketplace_sku) DO UPDATE SET
              last_seen = excluded.last_seen,
              occurrence_count = occurrence_count + 1`,
      args: [sku, dateStr, dateStr],
    });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const dates = buildDateRange(DAYS);
  console.log(`Backfilling ${dates.length} days: ${dates[0]} → ${dates[dates.length - 1]}`);

  // Load mapping/combo tables once for the entire backfill run
  const [mappingLookup, comboLookup] = await Promise.all([
    loadMappingLookup(),
    loadComboLookup(),
  ]);
  console.log(`Loaded ${mappingLookup.size} marketplace mappings, ${comboLookup.size} combo recipes`);

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
    console.log(`Loaded ${costMap.size} cost entries for COGS snapshotting`);
  } catch {
    console.log('unit_cost column not yet present — COGS will be NULL on allocation rows');
  }

  let totalOrderRows = 0;
  let totalAllocRows = 0;
  const allUnmapped = new Set();

  for (const dateStr of dates) {
    process.stdout.write(`  ${dateStr} ... `);
    try {
      const orders = await fetchOrdersForDate(dateStr);
      const orderRows = [];
      const allocationRows = [];
      const unmappedToday = new Set();

      for (const order of orders) {
        const paymentDate = order.OrderDetails.PaymentDate.slice(0, 10);
        if (paymentDate !== dateStr) continue;

        for (let i = 0; i < order.OrderItems.length; i++) {
          const item = order.OrderItems[i];
          // Use item.Name (storefront SKU), never item.ItemId (internal numeric ID)
          const marketplace_sku = (item.Name ?? '').trim();
          if (!marketplace_sku) continue;

          const { orderRow, allocationRows: allocRows, isUnmapped } = processItem(
            {
              marketplace_sku,
              order_id: order.TxnId,
              order_date: paymentDate,
              qty: item.Quantity,
              total_price: item.Amount,
              line_number: i,
            },
            mappingLookup,
            comboLookup,
            costMap
          );

          orderRows.push(orderRow);
          allocationRows.push(...allocRows);
          if (isUnmapped) unmappedToday.add(marketplace_sku);
        }
      }

      await upsertOrderRows(orderRows);
      await upsertAllocationRows(allocationRows);
      if (unmappedToday.size > 0) {
        await recordUnmappedSkus([...unmappedToday], dateStr);
        for (const s of unmappedToday) allUnmapped.add(s);
      }

      totalOrderRows += orderRows.length;
      totalAllocRows += allocationRows.length;
      console.log(
        `${orders.length} orders → ${orderRows.length} order rows, ${allocationRows.length} alloc rows` +
        (unmappedToday.size > 0 ? ` (${unmappedToday.size} unmapped)` : '')
      );
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }

    // Small delay to avoid hammering Teapplix API
    await new Promise((r) => setTimeout(r, 300));
  }

  const result = await db.execute('SELECT COUNT(*) as cnt FROM orders');
  const cnt = result.rows[0].cnt;
  const allocResult = await db.execute('SELECT COUNT(*) as cnt FROM order_item_allocations');
  const allocCnt = allocResult.rows[0].cnt;

  console.log(`\nDone.`);
  console.log(`  Inserted ${totalOrderRows} order rows. DB total: ${cnt}`);
  console.log(`  Inserted ${totalAllocRows} allocation rows. DB total: ${allocCnt}`);
  if (allUnmapped.size > 0) {
    console.log(`  Unmapped SKUs (${allUnmapped.size}): ${[...allUnmapped].join(', ')}`);
    console.log(`  → Add these to marketplace_item_mappings to fix inventory matching.`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
