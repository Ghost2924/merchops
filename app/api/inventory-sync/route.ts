export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { upsertInventory, upsertInventorySnapshot, clearRestockCaches } from '@/lib/db/queries';
import { migrate } from '@/lib/db/turso';
import { fetchAndAggregateInventory } from '@/lib/sync/inventory';

export async function POST() {
  try {
    await migrate();
    const rows = await fetchAndAggregateInventory();
    console.log(`[inventory-sync] aggregated ${rows.length} canonical SKUs`);

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
