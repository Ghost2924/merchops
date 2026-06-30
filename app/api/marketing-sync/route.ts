export const dynamic = 'force-dynamic';

/**
 * POST /api/marketing-sync
 *
 * Pulls Amazon marketing performance reports for the past N days (default 30,
 * max 90) and upserts per-ASIN data into:
 *
 *   asin_promotion_metrics   ← GET_PROMOTION_PERFORMANCE_REPORT (Vendor)
 *   daily_marketing_spend    ← aggregated promotion discount totals (backward compat)
 *
 * Auth: Bearer token via CRON_SECRET (same pattern as /api/sync).
 *
 * Query params:
 *   days  — number of days to cover (default 30, max 90)
 *
 * Env vars:
 *   CRON_SECRET                   – protects this endpoint
 *   AMAZON_VENDOR_CLIENT_ID       – LWA client ID
 *   AMAZON_VENDOR_CLIENT_SECRET   – LWA client secret
 *   AMAZON_VENDOR_REFRESH_TOKEN   – long-lived SP-API refresh token
 */

import { NextRequest, NextResponse } from 'next/server';
import { runMarketingSync } from '@/lib/sync/runMarketingSync';

export async function POST(req: NextRequest) {
  // Optional CRON_SECRET guard — present in production, skipped in dev if unset
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const { searchParams } = new URL(req.url);
    const rawDays = parseInt(searchParams.get('days') ?? '30', 10);
    // GET_PROMOTION_PERFORMANCE_REPORT supports up to 90-day windows via
    // standard ARA top-level date parameters.
    const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 90) : 30;

    const result = await runMarketingSync(days);
    const status = result.ok ? 200 : 500;
    return NextResponse.json(result, { status });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[/api/marketing-sync]', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
