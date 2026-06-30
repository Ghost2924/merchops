export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { migrate } from '@/lib/db/turso';
import { getRestockPlan } from '@/lib/db/queries';

export async function GET() {
  try {
    await migrate();
    const rows = await getRestockPlan();
    return NextResponse.json({ ok: true, data: rows, count: rows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
