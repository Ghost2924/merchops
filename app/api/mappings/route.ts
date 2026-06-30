export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { migrate } from '@/lib/db/turso';
import {
  getSkuMappings,
  getUnmappedSkus,
  getMappingErrors,
  upsertSkuMappings,
  resolveUnmappedSkus,
  clearRestockCaches,
} from '@/lib/db/queries';

export async function GET() {
  try {
    await migrate();

    // Return all three datasets in one response so the frontend can render
    // all tabs without making multiple round-trips.
    const [mappings, unmapped, errors] = await Promise.all([
      getSkuMappings(),
      getUnmappedSkus(),
      getMappingErrors(),
    ]);

    return NextResponse.json({
      ok: true,
      mappings,
      unmapped,
      errors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    await migrate();
    const body = await req.json();

    // Accept a single mapping object or an array
    const input = Array.isArray(body) ? body : [body];

    if (input.length === 0) {
      return NextResponse.json({ ok: false, error: 'No rows provided' }, { status: 400 });
    }

    // Frontend sends { storefront_sku, teapplix_sku } — map to SkuMappingRow shape
    const rows = input.map((item) => ({
      source_sku: item.storefront_sku ?? item.source_sku ?? '',
      teapplix_sku: item.teapplix_sku ?? '',
      marketplace: item.marketplace ?? 'UNKNOWN',
      mapping_type: item.mapping_type ?? 'manual',
      active: item.active ?? 1,
      confidence: item.confidence ?? 1.0,
      notes: item.notes ?? '',
    }));

    for (const row of rows) {
      if (!row.source_sku || !row.teapplix_sku) {
        return NextResponse.json(
          { ok: false, error: 'Each row must have storefront_sku and teapplix_sku' },
          { status: 400 }
        );
      }
    }

    await upsertSkuMappings(rows);

    // Mark these source SKUs as resolved in the unmapped queue so the
    // dashboard banner count drops without waiting for the next sync.
    await resolveUnmappedSkus(rows.map((r) => r.source_sku));

    clearRestockCaches();

    return NextResponse.json({ ok: true, inserted: rows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
