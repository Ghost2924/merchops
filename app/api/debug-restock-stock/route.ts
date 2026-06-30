export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/turso';
import { getDateNDaysAgoInTz } from '@/lib/db/queries';

/**
 * Debug endpoint: shows exactly where onHand AND velocity come from for a SKU family.
 * Usage: GET /api/debug-restock-stock?sku=5233
 *
 * Shows:
 * - current_qty per inventory_products row matching the family
 * - 90d depletion broken down by source_teapplix_sku (so you can see if packs are double-counting)
 * - allocation_type breakdown (direct vs combo_explode)
 * - daily rate implied by each source
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sku = searchParams.get('sku');
  if (!sku) {
    return NextResponse.json({ ok: false, error: 'Missing ?sku= param' }, { status: 400 });
  }

  const db = getDb();
  const days = parseInt(searchParams.get('days') ?? '90', 10);
  const windowStart = getDateNDaysAgoInTz(days);
  // Keep 90d for backward compat labels
  const cur90Start = getDateNDaysAgoInTz(90);

  // Strip AM prefix for pattern matching
  const baseSkuPattern = sku.replace(/^AM/i, '');

  const [
    inventoryRows,
    depletionBySource,
    depletionByAllocType,
    orderLineSample,
  ] = await Promise.all([
    // All inventory_products rows for this family
    db.execute({
      sql: `SELECT sku, title, current_qty, active, updated_at
            FROM inventory_products
            WHERE sku LIKE ? OR sku LIKE ? OR sku = ?
            ORDER BY sku`,
      args: [`%${baseSkuPattern}%`, `AM${baseSkuPattern}%`, sku],
    }),

    // 90d depletion broken down by WHICH source SKU caused it
    // This reveals if AM5233-2 orders contribute 2× and AM5233-5 contribute 5× etc.
    db.execute({
      sql: `SELECT
              ia.inventory_sku,
              ia.source_teapplix_sku,
              ia.allocation_type,
              COUNT(DISTINCT ia.order_line_id) AS order_count,
              SUM(ia.qty_depleted) AS total_base_units,
              ROUND(SUM(ia.qty_depleted) * 1.0 / ? , 2) AS implied_daily_rate
            FROM inventory_allocations ia
            JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
            WHERE ia.inventory_sku LIKE ?
              AND ol.order_date >= ?
            GROUP BY ia.inventory_sku, ia.source_teapplix_sku, ia.allocation_type
            ORDER BY total_base_units DESC`,
      args: [days, `%${baseSkuPattern}%`, windowStart],
    }),

    // Totals per inventory_sku + allocation_type
    db.execute({
      sql: `SELECT
              ia.inventory_sku,
              ia.allocation_type,
              SUM(ia.qty_depleted) AS total_base_units,
              COUNT(DISTINCT ol.order_date) AS in_stock_days,
              ROUND(SUM(ia.qty_depleted) * 1.0 / ?, 2) AS raw_daily_rate
            FROM inventory_allocations ia
            JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
            WHERE ia.inventory_sku LIKE ?
              AND ol.order_date >= ?
            GROUP BY ia.inventory_sku, ia.allocation_type
            ORDER BY ia.inventory_sku, ia.allocation_type`,
      args: [days, `%${baseSkuPattern}%`, windowStart],
    }),

    // ALL order lines (not just sample) — full list so you can count against Teapplix
    db.execute({
      sql: `SELECT
              ol.order_date,
              ol.customer_order_id,
              ol.raw_storefront_sku,
              ol.resolved_teapplix_sku,
              ol.qty_sold AS order_qty_sold,
              ia.inventory_sku,
              ia.qty_depleted,
              ia.allocation_type
            FROM order_lines ol
            JOIN inventory_allocations ia ON ia.order_line_id = ol.order_line_id
            WHERE ia.inventory_sku LIKE ?
              AND ol.order_date >= ?
            ORDER BY ol.order_date DESC`,
      args: [`%${baseSkuPattern}%`, windowStart],
    }),
  ]);

  // Compute family total on-hand from inventory_products (no packStockMap)
  const familyOnHand = inventoryRows.rows
    .filter((r) => Number(r.active) === 1)
    .reduce((s, r) => s + Number(r.current_qty), 0);

  // Total depletion for the window
  const totalDepletionWindow = depletionByAllocType.rows.reduce(
    (s, r) => s + Number(r.total_base_units), 0
  );

  return NextResponse.json({
    sku,
    baseSkuPattern,
    windowDays: days,
    windowStart,

    // Stock
    familyOnHand_sumOfCurrentQty: familyOnHand,
    inventoryProductRows: inventoryRows.rows,

    // Velocity data
    totalDepletionInWindow: totalDepletionWindow,
    rawDailyRate: Math.round((totalDepletionWindow / days) * 100) / 100,
    depletionBySourceSku: depletionBySource.rows,
    depletionByAllocType: depletionByAllocType.rows,

    // ALL order lines in window — compare row-by-row against Teapplix
    allOrderLines: orderLineSample.rows,
    totalOrderLineCount: orderLineSample.rows.length,
  });
}
