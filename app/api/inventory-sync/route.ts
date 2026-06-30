export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { fetchInventory } from '@/lib/teapplix/live-client';
import { upsertInventory, upsertInventorySnapshot, normalizeSku, InventoryRow, clearRestockCaches } from '@/lib/db/queries';
import { migrate } from '@/lib/db/turso';

export async function POST(req: Request) {
  try {
    await migrate();
    const products = await fetchInventory();
    console.log(`[inventory-sync] fetched ${products.length} products`);

    // ProductQuantity endpoint only returns physical inventory items —
    // no ItemType filtering needed here. Aggregate by normalized SKU
    // in case Teapplix sends pack variants as separate rows.
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

    const rows: InventoryRow[] = [...aggregated.values()];
    console.log(`[inventory-sync] aggregated ${products.length} API rows → ${rows.length} canonical SKUs`);

    await upsertInventory(rows);
    await upsertInventorySnapshot(rows);

    clearRestockCaches();
    revalidatePath('/');

    return NextResponse.json({ ok: true, productCount: rows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[/api/inventory-sync]', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
