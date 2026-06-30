export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { migrate } from '@/lib/db/turso';
import { getDb } from '@/lib/db/turso';
import {
  getInventoryProducts,
  getComboProducts,
  getComboComponents,
  getMappingErrors,
} from '@/lib/db/queries';

export async function GET(req: Request) {
  try {
    await migrate();
    const { searchParams } = new URL(req.url);
    const view = searchParams.get('view');

    // Validation endpoint — separate from the main data fetch
    if (view === 'validate') {
      const db = getDb();

      const [orphanParents, orphanChildren, badMappings, badQty, badAllocations] = await Promise.all([
        db.execute(`
          SELECT DISTINCT cc.combo_sku
          FROM combo_components cc
          LEFT JOIN combo_products cp ON cp.sku = cc.combo_sku
          WHERE cp.sku IS NULL
        `),
        db.execute(`
          SELECT DISTINCT cc.combo_sku, cc.child_inventory_sku
          FROM combo_components cc
          LEFT JOIN inventory_products ip ON ip.sku = cc.child_inventory_sku
          WHERE ip.sku IS NULL
        `),
        db.execute(`
          SELECT sm.source_sku, sm.teapplix_sku
          FROM sku_mappings sm
          LEFT JOIN inventory_products ip ON ip.sku = sm.teapplix_sku
          LEFT JOIN combo_products cp ON cp.sku = sm.teapplix_sku
          WHERE ip.sku IS NULL AND cp.sku IS NULL AND sm.active = 1
          LIMIT 100
        `),
        db.execute(`
          SELECT combo_sku, child_inventory_sku, quantity
          FROM combo_components WHERE quantity <= 0
        `),
        db.execute(`
          SELECT DISTINCT ia.inventory_sku
          FROM inventory_allocations ia
          INNER JOIN combo_products cp ON cp.sku = ia.inventory_sku
          LIMIT 50
        `),
      ]);

      return NextResponse.json({
        ok: true,
        orphanCombos: orphanParents.rows.length,
        badMappingTargets: badMappings.rows.length,
        invalidQuantities: badQty.rows.length,
        allocationsOnCombos: badAllocations.rows.length,
        details: {
          orphanParents: orphanParents.rows,
          orphanChildren: orphanChildren.rows,
          badMappings: badMappings.rows,
          badQty: badQty.rows,
          badAllocations: badAllocations.rows,
        },
      });
    }

    // Default: return all catalog data in one response so the frontend
    // can render all tabs without multiple round-trips.
    const db = getDb();

    const [invProducts, comboProducts, components, errors, needsReviewResult] = await Promise.all([
      getInventoryProducts(),
      getComboProducts(),
      getComboComponents(),
      getMappingErrors(),
      db.execute(
        `SELECT sku, title, item_type, reason, created_at FROM needs_review_products ORDER BY created_at DESC`
      ),
    ]);

    // Build combo → components map for the frontend
    const comboMap = new Map<string, { sku: string; qty: number }[]>();
    for (const comp of components) {
      const list = comboMap.get(comp.combo_sku) ?? [];
      list.push({ sku: comp.child_inventory_sku, qty: comp.quantity });
      comboMap.set(comp.combo_sku, list);
    }

    // Build storefront SKU → physical SKU reverse map from sku_mappings.
    // Only include non-ASIN source_skus (ASINs are B0... format — not useful to display).
    const mappingsResult = await db.execute(
      `SELECT source_sku, teapplix_sku FROM sku_mappings WHERE active = 1`
    );
    const ASIN_RE = /^B0[A-Z0-9]{8}$/;
    const physicalToStorefront = new Map<string, string[]>();
    for (const row of mappingsResult.rows) {
      const physical = row.teapplix_sku as string;
      const storefront = row.source_sku as string;
      // Skip ASINs — show only human-readable SKU aliases
      if (ASIN_RE.test(storefront)) continue;
      const list = physicalToStorefront.get(physical) ?? [];
      list.push(storefront);
      physicalToStorefront.set(physical, list);
    }

    const inventorySkus = invProducts.map((p) => ({
      sku: p.sku,
      description: p.title || undefined,
      qty: p.current_qty,
      itemType: 'inventory',
      updatedAt: p.updated_at ?? undefined,
      storefrontSkus: physicalToStorefront.get(p.sku) ?? [],
    }));

    const comboSkus = comboProducts.map((p) => ({
      sku: p.sku,
      description: p.title || undefined,
      components: comboMap.get(p.sku) ?? [],
    }));

    const needsReview = needsReviewResult.rows.map((r) => ({
      sku: r.sku as string,
      description: (r.title as string) || undefined,
      qty: 0,
      itemType: (r.item_type as string) || 'unknown',
    }));

    return NextResponse.json({
      ok: true,
      inventorySkus,
      comboSkus,
      needsReview,
      mappingErrors: errors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
