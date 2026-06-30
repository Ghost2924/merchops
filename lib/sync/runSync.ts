/**
 * runSync — shared core for /api/sync (cron) and /api/manual-sync (UI button).
 *
 * Handles: lookup builds, order fetch + ingest, inventory sync, cache bust.
 * Does NOT handle: auth checks, marketing sync timing, or HTTP responses.
 */

import { revalidateTag } from 'next/cache';
import { fetchOrdersByDate, fetchInventory, TeapplixOrder } from '@/lib/teapplix/live-client';
import {
  upsertOrderLines,
  upsertInventoryAllocations,
  upsertOrders,
  upsertInventory,
  upsertInventorySnapshot,
  normalizeSku,
  InventoryRow,
  buildSyncLookups,
  recordUnmappedSku,
  insertMappingErrors,
  buildIngestRows,
  RawOrderItem,
  getTodayInTz,
  getDateNDaysAgoInTz,
  clearRestockCaches,
} from '@/lib/db/queries';
import { getDb } from '@/lib/db/turso';
import { runWithOrg, getOrgContext } from '@/lib/db/context';

export interface SyncDateResult {
  date: string;
  orderCount: number;
  orderLineCount: number;
  allocationCount: number;
  unmappedSkuCount: number;
  mappingErrorCount: number;
  error?: string;
}

export interface SyncResult {
  dates: string[];
  results: SyncDateResult[];
  inventorySkuCount: number;
}

export interface RunSyncOptions {
  /** Sync a specific date. Defaults to today (for manual-sync) or yesterday+gaps (for cron). */
  targetDate?: string;
  /** For cron mode: how many days back to check for gaps. Default 7, max 30. */
  lookbackDays?: number;
  /** Whether this is the "today" (manual) mode vs "yesterday+gaps" (cron) mode. */
  mode: 'today' | 'backfill';
  /** Optional organization ID for multi-tenant background execution. */
  organizationId?: string;
}

function toRawItems(orders: TeapplixOrder[], targetDate: string): RawOrderItem[] {
  const items: RawOrderItem[] = [];
  let droppedCount = 0;
  for (const order of orders) {
    const paymentDate = order.OrderDetails.PaymentDate.slice(0, 10);
    // NOTE: Previously this function filtered `if (paymentDate !== targetDate) continue`,
    // which silently dropped orders where Teapplix's server-side PaymentDate (UTC/Eastern)
    // didn't exactly match the targetDate in the business timezone (Pacific). This caused
    // undercounting — e.g. 35 orders shown vs 49 in Teapplix for the same day.
    //
    // The API already filters by PaymentDateStart/PaymentDateEnd, so every order returned
    // belongs to the requested window. We use each order's own PaymentDate as order_date
    // rather than forcing all rows onto targetDate. This means a ±1-day timezone-boundary
    // order lands on its actual payment date, not silently dropped.
    if (paymentDate < targetDate) {
      // Order paid before our window (edge case from pagination overlap) — skip and log.
      droppedCount++;
      continue;
    }
    for (let i = 0; i < order.OrderItems.length; i++) {
      const item = order.OrderItems[i];
      const marketplace_sku = (item.Name ?? '').trim();
      if (!marketplace_sku) continue;
      // item.Quantity = raw order count. Pack-size multiply happens post-mapping
      // in buildIngestRows using the resolved Teapplix SKU suffix, not the ASIN.
      items.push({
        marketplace_sku,
        order_id: order.TxnId,
        order_date: paymentDate,   // use the actual PaymentDate, not forced to targetDate
        marketplace: order.StoreType ?? 'UNKNOWN',
        qty: item.Quantity,
        total_price: item.Amount,
        line_number: i,
      });
    }
  }
  if (droppedCount > 0) {
    console.warn(`[toRawItems] dropped ${droppedCount} orders with paymentDate < ${targetDate} (pagination overlap)`);
  }
  console.log(`[toRawItems] ${targetDate}: ${orders.length} orders → ${items.length} line items (${droppedCount} dropped)`);
  return items;
}

async function findMissingDates(lookbackDays: number): Promise<string[]> {
  const db = getDb();
  const today = getTodayInTz();

  const expected: string[] = [];
  for (let i = 1; i <= lookbackDays; i++) {
    expected.push(getDateNDaysAgoInTz(i));
  }

  const result = await db.execute({
    sql: `SELECT DISTINCT order_date FROM order_lines
          WHERE order_date >= ? AND order_date < ?
          ORDER BY order_date ASC`,
    args: [getDateNDaysAgoInTz(lookbackDays), today],
  });
  const present = new Set(result.rows.map((r) => r.order_date as string));

  return expected.filter((d) => !present.has(d));
}

async function syncOneDate(
  targetDate: string,
  mappingLookup: Map<string, string>,
  comboLookup: Map<string, any>,
  inventorySkuSet: Set<string>,
  comboSkuSet: Set<string>
): Promise<SyncDateResult> {
  const orders = await fetchOrdersByDate(targetDate, targetDate);
  console.log(`[runSync] fetched ${orders.length} orders for ${targetDate}`);

  const rawItems = toRawItems(orders, targetDate);
  const { orderLineRows, allocationRows, unmappedSkus, mappingErrors, orderRows } =
    buildIngestRows(rawItems, mappingLookup, comboLookup, inventorySkuSet, comboSkuSet);

  await Promise.all([
    upsertOrderLines(orderLineRows),
    upsertInventoryAllocations(allocationRows),
    upsertOrders(orderRows),
  ]);

  if (unmappedSkus.length > 0) {
    console.warn(`[runSync] ${unmappedSkus.length} unmapped SKUs for ${targetDate}:`, unmappedSkus);
    const unmappedItems = rawItems.filter((i) => unmappedSkus.includes(i.marketplace_sku));
    await Promise.all(
      unmappedSkus.map((sku) => {
        const items = unmappedItems.filter((i) => i.marketplace_sku === sku);
        const qty = items.reduce((s, i) => s + i.qty, 0);
        const revenue = items.reduce((s, i) => s + i.total_price, 0);
        return recordUnmappedSku(sku, targetDate, items[0]?.marketplace, qty, revenue);
      })
    );
  }

  if (mappingErrors.length > 0) {
    console.warn(`[runSync] ${mappingErrors.length} mapping errors for ${targetDate}:`, mappingErrors);
    await insertMappingErrors(
      mappingErrors.map((sku) => ({
        error_type: 'missing_target',
        teapplix_sku: sku,
        message: `Mapping target "${sku}" not found in product catalog`,
        severity: 'error',
      }))
    );
  }

  return {
    date: targetDate,
    orderCount: orders.length,
    orderLineCount: orderLineRows.length,
    allocationCount: allocationRows.length,
    unmappedSkuCount: unmappedSkus.length,
    mappingErrorCount: mappingErrors.length,
  };
}

export async function runSync(options: RunSyncOptions): Promise<SyncResult> {
  const orgId = options.organizationId ?? getOrgContext().orgId;
  if (orgId) {
    return runWithOrg(orgId, false, () => runSyncInternal(options));
  } else {
    return runSyncInternal(options);
  }
}

async function runSyncInternal(options: RunSyncOptions): Promise<SyncResult> {
  // Single batch round-trip builds all 4 lookups
  const { mappingLookup, comboLookup, inventoryProductMap, comboSkuSet } = await buildSyncLookups();
  const inventorySkuSet = new Set(inventoryProductMap.keys());

  // Determine which dates to sync
  let datesToSync: string[];

  if (options.mode === 'today') {
    datesToSync = [options.targetDate ?? getTodayInTz()];
  } else {
    // backfill mode: yesterday + any gaps in lookback window
    const lookbackDays = Math.min(Math.max(options.lookbackDays ?? 7, 1), 30);
    const yesterday = getDateNDaysAgoInTz(1);
    const missingDates = await findMissingDates(lookbackDays);
    datesToSync = [yesterday, ...missingDates.filter((d) => d !== yesterday)];
    console.log(`[runSync] dates to sync: ${datesToSync.join(', ')} (${missingDates.length} gap(s))`);
  }

  // Sync each date sequentially (avoids parallel Teapplix API hammering)
  const results: SyncDateResult[] = [];
  for (const date of datesToSync) {
    try {
      const r = await syncOneDate(date, mappingLookup, comboLookup, inventorySkuSet, comboSkuSet);
      results.push(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[runSync] failed for ${date}:`, msg);
      results.push({ date, orderCount: 0, orderLineCount: 0, allocationCount: 0, unmappedSkuCount: 0, mappingErrorCount: 0, error: msg });
    }
  }

  // Sync inventory quantities — only when called from manual-sync UI button.
  // Cron mode uses the dedicated /api/inventory-sync step instead.
  let inventorySkuCount = 0;
  if (options.mode === 'today') {
    try {
      const products = await fetchInventory();
      const aggregated = new Map<string, InventoryRow>();
      for (const p of products) {
        const sku = normalizeSku((p.ItemName as string) ?? '');
        if (!sku) continue;
        if (!aggregated.has(sku)) {
          aggregated.set(sku, {
            sku,
            item_title: (p.ItemTitle as string) ?? '',
            asin: (p.Asin as string) ?? '',
            upc: (p.Upc as string) ?? '',
            qty_on_hand: 0,
            qty_to_ship: 0,
            qty_available: 0,
            unit_cost: Number(p.UnitCost) || 0,
            last_synced: new Date().toISOString(),
          });
        }
        const row = aggregated.get(sku)!;
        row.qty_on_hand   += Number(p.QtyOnHand)   || 0;
        row.qty_to_ship   += Number(p.QtyToShip)   || 0;
        row.qty_available += Number(p.QtyAvailable) || 0;
        if (!row.item_title && p.ItemTitle) row.item_title = p.ItemTitle as string;
        if (!row.asin && p.Asin) row.asin = p.Asin as string;
        if (!row.upc && p.Upc) row.upc = p.Upc as string;
        if (!row.unit_cost && p.UnitCost) row.unit_cost = Number(p.UnitCost) || 0;
      }
      const invRows: InventoryRow[] = [...aggregated.values()];
      await upsertInventory(invRows);
      await upsertInventorySnapshot(invRows);
      inventorySkuCount = invRows.length;
      console.log(`[runSync] inventory synced: ${inventorySkuCount} SKUs`);
    } catch (invErr) {
      console.error('[runSync] inventory sync failed (non-fatal):', invErr instanceof Error ? invErr.message : invErr);
    }
  }

  clearRestockCaches();

  // Bust the dashboard cache so next page load re-queries
  revalidateTag('dashboard-data');

  return { dates: datesToSync, results, inventorySkuCount };
}
