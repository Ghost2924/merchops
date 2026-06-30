/**
 * /api/admin/patch-pack-qty
 *
 * One-shot route that fixes stale qty_sold / qty_depleted for all order_lines
 * where the resolved_teapplix_sku has a numeric or word pack-size suffix that
 * was previously ignored (defaulted to ×1).
 *
 * Protected by session cookie (same as manual-sync).
 * Pass ?apply=true to write changes. Default is dry-run.
 *
 * DELETE THIS ROUTE after running once.
 */
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getDb, migrate } from '@/lib/db/turso';
import { parsePack } from '@/lib/sku/resolver';

function getMultiplier(sku: string): number | null {
  const { qty } = parsePack(sku);
  return qty >= 2 ? qty : null;
}

export async function GET(req: NextRequest) {
  // Bearer token auth — same secret as cron endpoints
  const auth = req.headers.get('authorization') ?? '';
  const secret = process.env.CRON_SECRET;
  if (secret && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const apply = req.nextUrl.searchParams.get('apply') === 'true';

  try {
    await migrate();
    const db = getDb();

    // Fetch all order_lines with a suffixed resolved SKU
    const allRows = await db.execute(
      `SELECT order_line_id, resolved_teapplix_sku, qty_sold
       FROM order_lines
       WHERE resolved_teapplix_sku IS NOT NULL
         AND resolved_teapplix_sku LIKE '%-%'`
    );

    interface Patch {
      order_line_id: string;
      sku: string;
      oldQty: number;
      newQty: number;
      mult: number;
    }

    const patches: Patch[] = [];
    for (const row of allRows.rows) {
      const sku = row.resolved_teapplix_sku as string;
      const mult = getMultiplier(sku);
      if (!mult) continue;
      const oldQty = Number(row.qty_sold);
      if (oldQty === 0) continue;
      patches.push({
        order_line_id: row.order_line_id as string,
        sku,
        oldQty,
        newQty: oldQty * mult,
        mult,
      });
    }

    // Summarise by SKU
    const bySku: Record<string, { mult: number; rows: number }> = {};
    for (const p of patches) {
      if (!bySku[p.sku]) bySku[p.sku] = { mult: p.mult, rows: 0 };
      bySku[p.sku].rows++;
    }

    // inventory_allocations — direct rows
    interface AllocPatch {
      rowid: number;
      sku: string;
      oldQty: number;
      newQty: number;
      mult: number;
    }
    const allocPatches: AllocPatch[] = [];
    const lineIds = patches.map(p => p.order_line_id);

    if (lineIds.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < lineIds.length; i += CHUNK) {
        const chunk = lineIds.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const allocRows = await db.execute({
          sql: `SELECT ia.rowid AS rowid, ia.qty_depleted, ol.resolved_teapplix_sku
                FROM inventory_allocations ia
                JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
                WHERE ia.order_line_id IN (${placeholders})
                  AND ia.allocation_type = 'direct'`,
          args: chunk,
        });
        for (const row of allocRows.rows) {
          const sku = row.resolved_teapplix_sku as string;
          const mult = getMultiplier(sku);
          if (!mult) continue;
          const oldQty = Number(row.qty_depleted);
          if (oldQty === 0) continue;
          allocPatches.push({
            rowid: Number(row.rowid),
            sku,
            oldQty,
            newQty: oldQty * mult,
            mult,
          });
        }
      }
    }

    if (!apply) {
      return NextResponse.json({
        mode: 'dry-run',
        orderLinesAffected: patches.length,
        allocationsAffected: allocPatches.length,
        skuBreakdown: bySku,
        note: 'Add ?apply=true to write changes',
      });
    }

    // Apply order_lines patches in batches
    const WRITE_CHUNK = 100;
    for (let i = 0; i < patches.length; i += WRITE_CHUNK) {
      const chunk = patches.slice(i, i + WRITE_CHUNK);
      await db.batch(
        chunk.map(p => ({
          sql: `UPDATE order_lines SET qty_sold = ? WHERE order_line_id = ?`,
          args: [p.newQty, p.order_line_id],
        }))
      );
    }

    // Apply allocation patches
    for (let i = 0; i < allocPatches.length; i += WRITE_CHUNK) {
      const chunk = allocPatches.slice(i, i + WRITE_CHUNK);
      await db.batch(
        chunk.map(p => ({
          sql: `UPDATE inventory_allocations SET qty_depleted = ? WHERE rowid = ?`,
          args: [p.newQty, p.rowid],
        }))
      );
    }

    return NextResponse.json({
      mode: 'applied',
      orderLinesPatched: patches.length,
      allocationsPatched: allocPatches.length,
      skuBreakdown: bySku,
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[patch-pack-qty]', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
