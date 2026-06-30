/**
 * /api/vendor-sync — Cron endpoint for Amazon Vendor ARA data.
 *
 * Auth: Bearer token via CRON_SECRET (same pattern as /api/marketing-sync).
 *
 * Core logic lives in lib/sync/runVendorSync.ts so it can also be called
 * as a background task from /api/manual-sync (the UI Sync button).
 */

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { runVendorSync } from '@/lib/sync/runVendorSync';

export async function POST(req: NextRequest) {
  try {
    const result = await runVendorSync();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[/api/vendor-sync]', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
