export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  getTodayInTz,
  buildMappingLookup,
  getInventoryProductMap,
  getComboProducts,
} from '@/lib/db/queries';
import { migrate } from '@/lib/db/turso';
import { fetchOrdersByDate } from '@/lib/teapplix/live-client';
import { getDataProvider } from '@/lib/data/provider';

const MOCK_TITLES: Record<string, string> = {
  'TEA-GREEN-100': 'Premium Green Tea (100 bags)',
  'TEA-BLACK-100': 'Classic Black Tea (100 bags)',
  'TEA-OOLONG-50': 'Oolong Blossom Tea (50 bags)',
  'TEA-WHITE-50': 'White Peony Tea (50 bags)',
  'TEA-HERBAL-75': 'Herbal Chamomile Mint (75 bags)',
  'TEA-CHAI-100': 'Masala Chai Tea (100 bags)',
  'TEA-MATCHA-30': 'Organic Matcha Powder (30g)',
  'TEA-ROOIBOS-75': 'Red Bush Rooibos (75 bags)',
  'TEA-PEPPERMINT-50': 'Pure Peppermint Leaves (50 bags)',
  'TEA-CHAMOMILE-50': 'Sleepy Chamomile Flowers (50 bags)',
  'TEA-EARL-GREY-100': 'Aromatic Earl Grey (100 bags)',
  'TEA-JASMINE-50': 'Jasmine Green Tea (50 bags)',
  'TEA-GINGER-75': 'Ginger Lemon Infusion (75 bags)',
  'TEA-TURMERIC-30': 'Turmeric Golden Powder (30g)',
  'TEA-HIBISCUS-50': 'Tart Hibiscus Flower (50 bags)',
  'TEAPOT-CERAMIC-1': 'Classic Ceramic Teapot',
  'TEAPOT-GLASS-1': 'Modern Glass Teapot',
  'INFUSER-BALL-1': 'Stainless Steel Mesh Ball Infuser',
  'INFUSER-BASKET-1': 'Deep Brew Basket Infuser',
  'GIFT-SET-PREMIUM-1': 'Ultimate Connoisseur Tea Gift Set',
};

const MOCK_COMBO_RECIPES: Record<string, { sku: string; qty: number }[]> = {
  'GIFT-SET-PREMIUM-1': [
    { sku: 'TEAPOT-GLASS-1', qty: 1 },
    { sku: 'TEA-GREEN-100', qty: 1 },
    { sku: 'TEA-BLACK-100', qty: 1 },
    { sku: 'INFUSER-BALL-1', qty: 1 },
  ],
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const daysParam = parseInt(searchParams.get('days') ?? '1', 10);
  const days = Math.min(Math.max(isNaN(daysParam) ? 1 : daysParam, 1), 5);

  const isMock = process.env.NEXT_PUBLIC_USE_MOCK_DATA === 'true';

  try {
    if (isMock) {
      // --- MOCK MODE ---
      const provider = getDataProvider();
      const todaySummary = await provider.getTodaySummary();
      if (!todaySummary || !todaySummary.skus || todaySummary.skus.length === 0) {
        return NextResponse.json({ ok: true, data: [], count: 0, date: getTodayInTz() });
      }

      // Aggregate quantities by SKU (exploding combos)
      const aggregated = new Map<string, number>();

      for (const item of todaySummary.skus) {
        const qty = item.quantitySold;
        const comboRecipe = MOCK_COMBO_RECIPES[item.sku];

        if (comboRecipe) {
          // Explode mock combo
          for (const component of comboRecipe) {
            const current = aggregated.get(component.sku) ?? 0;
            aggregated.set(component.sku, current + qty * component.qty);
          }
        } else {
          // Direct item
          const current = aggregated.get(item.sku) ?? 0;
          aggregated.set(item.sku, current + qty);
        }
      }

      // Build output with titles
      const pickList = Array.from(aggregated.entries()).map(([sku, qty]) => ({
        sku,
        title: MOCK_TITLES[sku] ?? sku,
        qty,
      })).sort((a, b) => a.sku.localeCompare(b.sku));

      return NextResponse.json({
        ok: true,
        data: pickList,
        count: pickList.length,
        date: todaySummary.date,
        days,
        mode: 'mock',
      });
    }

    // --- LIVE MODE ---
    await migrate();
    const today = getTodayInTz();

    // Compute start date for the requested day range
    const startDate = (() => {
      const d = new Date(today + 'T00:00:00');
      d.setDate(d.getDate() - (days - 1));
      return d.toISOString().slice(0, 10);
    })();

    // 1. Fetch unshipped (open) orders for the date range from Teapplix REST API
    const orders = await fetchOrdersByDate(startDate, today, true);
    console.log(`[pick-list API] fetched ${orders.length} unshipped orders for ${startDate} → ${today} (${days}d)`);

    // 2. Load mappings and catalog product lookups
    const [mappingLookup, inventoryProductMap, comboProducts] = await Promise.all([
      buildMappingLookup(),
      getInventoryProductMap(),
      getComboProducts(),
    ]);

    const comboProductMap = new Map(comboProducts.map((c) => [c.sku, c]));

    // Case-insensitive fallbacks for auto-mapping
    const lowerInventoryMap = new Map<string, string>();
    for (const sku of inventoryProductMap.keys()) {
      lowerInventoryMap.set(sku.toLowerCase().trim(), sku);
    }

    // 3. Process orders and explode combos
    const aggregated = new Map<string, number>();

    for (const order of orders) {
      for (const item of order.OrderItems) {
        const rawSku = (item.Name ?? '').trim();
        if (!rawSku) continue;
        const qty = item.Quantity;

        // Resolve storefront SKU
        let teapplixSku: string | null = null;
        if (mappingLookup.has(rawSku)) {
          teapplixSku = mappingLookup.get(rawSku)!;
        } else {
          const lower = rawSku.toLowerCase().trim();
          if (mappingLookup.has(lower)) {
            teapplixSku = mappingLookup.get(lower)!;
          }
        }

        // Fallback auto-mapping
        if (teapplixSku === null) {
          const lower = rawSku.toLowerCase().trim();
          if (lowerInventoryMap.has(lower)) {
            teapplixSku = lowerInventoryMap.get(lower)!;
          }
        }

        if (teapplixSku === null) {
          // Unmapped storefront SKU — keep raw
          const current = aggregated.get(rawSku) ?? 0;
          aggregated.set(rawSku, current + qty);
        } else {
          // Keep each resolved SKU as-is (no combo explosion).
          // Combos like AM5233-10 stay as AM5233-10 so the pick list
          // shows exactly what was ordered, not a merged physical count.
          const current = aggregated.get(teapplixSku) ?? 0;
          aggregated.set(teapplixSku, current + qty);
        }
      }
    }

    // 4. Build pick list with product titles from catalog
    const pickList = Array.from(aggregated.entries()).map(([sku, qty]) => {
      let title = sku;
      if (inventoryProductMap.has(sku)) {
        title = inventoryProductMap.get(sku)!.title;
      } else if (comboProductMap.has(sku)) {
        title = comboProductMap.get(sku)!.title;
      }
      return { sku, title, qty };
    }).sort((a, b) => a.sku.localeCompare(b.sku));

    return NextResponse.json({
      ok: true,
      data: pickList,
      count: pickList.length,
      date: today,
      startDate,
      days,
      mode: 'live',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/pick-list] Error:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
