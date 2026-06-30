export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { migrate } from '@/lib/db/turso';
import { runSync } from '@/lib/sync/runSync';

// Cron endpoint — called by GitHub Actions / Vercel Cron.
// Protected by Bearer token (CRON_SECRET). Runs migration on cold start.

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const dateParam = searchParams.get('date');
  const backfillParam = searchParams.get('backfill');

  try {
    // migrate() is a no-op after first run — guarded by module-level
    // _appliedVersion flag in turso.ts. Runs DDL on deploy/cold start only.
    await migrate();

    if (dateParam) {
      // Explicit single-date mode
      const result = await runSync({ mode: 'today', targetDate: dateParam });
      return NextResponse.json({ ok: true, synced: result.results });
    }

    // Auto mode: yesterday + gap backfill
    const lookbackDays = backfillParam
      ? Math.min(Math.max(parseInt(backfillParam, 10) || 7, 1), 30)
      : 7;

    const result = await runSync({ mode: 'backfill', lookbackDays });

    return NextResponse.json({
      ok: true,
      synced: result.results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[/api/sync] Error:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
