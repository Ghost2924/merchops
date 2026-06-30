export const dynamic = 'force-dynamic';

/**
 * GET /api/sync-status
 *
 * Returns the current sync progress row from sync_status table.
 * Polled by the dashboard UI every few seconds after clicking Sync
 * so the user sees live phase/detail instead of a spinner with no feedback.
 *
 * Response shape:
 *   { phase, detail, done, error, updated_at }
 *
 * Phases (set by manual-sync and runVendorSync):
 *   idle            — no sync in progress
 *   orders:syncing  — fetching Teapplix orders + inventory
 *   orders:done     — orders/inventory complete
 *   vendor:starting — vendor sync kicked off (by cron)
 *   vendor:polling  — waiting for SP-API report (reportType in detail)
 *   vendor:downloading — downloading completed report
 *   vendor:done     — all vendor reports finished
 *   error           — sync failed (detail = error message)
 */

import { NextResponse } from 'next/server';
import { getDb, migrate } from '@/lib/db/turso';

export async function GET() {
  try {
    await migrate();
    const db = getDb();
    const result = await db.execute(
      `SELECT phase, detail, done, error, started_at, updated_at
       FROM sync_status WHERE id = 'current' LIMIT 1`
    );

    if (result.rows.length === 0) {
      return NextResponse.json({
        phase: 'idle',
        detail: null,
        done: false,
        error: null,
        updated_at: null,
      });
    }

    const r = result.rows[0];
    return NextResponse.json({
      phase:      r.phase      as string,
      detail:     r.detail     as string | null,
      done:       Boolean(r.done),
      error:      r.error      as string | null,
      started_at: r.started_at as string | null,
      updated_at: r.updated_at as string | null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[/api/sync-status]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
