export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getSeasonalRestockPlan } from '@/lib/db/queries';

export async function GET() {
  try {
    // migrate() is called on dashboard page load — no need to repeat here
    const rows = await getSeasonalRestockPlan();
    return NextResponse.json({ rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[/api/seasonal-restock]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
