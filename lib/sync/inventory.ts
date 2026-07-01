/**
 * lib/sync/inventory.ts
 *
 * Shared inventory fetch + aggregation logic.
 * Single authoritative copy used by inventory-sync/route.ts and runSync.ts.
 */

import { fetchInventory } from '@/lib/teapplix/live-client';
import { normalizeSku, InventoryRow } from '@/lib/db/queries';

/**
 * Fetch all inventory from Teapplix and aggregate by normalized SKU.
 * Returns canonical InventoryRow[] ready for upsertInventory / upsertInventorySnapshot.
 */
export async function fetchAndAggregateInventory(): Promise<InventoryRow[]> {
  const products = await fetchInventory();

  const aggregated = new Map<string, InventoryRow>();
  for (const p of products) {
    const sku = normalizeSku((p.ItemName as string) ?? '');
    if (!sku) continue;

    if (!aggregated.has(sku)) {
      aggregated.set(sku, {
        sku,
        item_title:    (p.ItemTitle as string) ?? '',
        asin:          (p.Asin as string) ?? '',
        upc:           (p.Upc as string) ?? '',
        qty_on_hand:   0,
        qty_to_ship:   0,
        qty_available: 0,
        unit_cost:     Number(p.UnitCost) || 0,
        last_synced:   new Date().toISOString(),
      });
    }

    const row = aggregated.get(sku)!;
    row.qty_on_hand   += Number(p.QtyOnHand)   || 0;
    row.qty_to_ship   += Number(p.QtyToShip)   || 0;
    row.qty_available += Number(p.QtyAvailable) || 0;
    if (!row.item_title && p.ItemTitle) row.item_title = p.ItemTitle as string;
    if (!row.asin      && p.Asin)      row.asin       = p.Asin as string;
    if (!row.upc       && p.Upc)       row.upc        = p.Upc as string;
    if (!row.unit_cost && p.UnitCost)  row.unit_cost  = Number(p.UnitCost) || 0;
  }

  return [...aggregated.values()];
}
