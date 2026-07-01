export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { runSync } from '@/lib/sync/runSync';
import { runMarketingSync } from '@/lib/sync/runMarketingSync';
import { migrate } from '@/lib/db/turso';
import { writeSyncStatus } from '@/lib/db/sync-status';
import { upsertAsinAdSpend, upsertDailyMarketingSpend } from '@/lib/db/ads-queries';
import { getDateNDaysAgoInTz } from '@/lib/db/queries';

// /api/manual-sync — called by the SyncButton in the dashboard UI.
// Protected by the session cookie middleware — no Bearer token needed.
//
// Phase 1 (orders + inventory) is blocking — returns 200 with results.
// Marketing sync + ads-sync fire non-blocking after response.
// Vendor sync runs via the existing nightly cron (/api/vendor-sync) only.

async function runAdsSyncBackground(): Promise<void> {
  const endDate   = getDateNDaysAgoInTz(1);
  const startDate = getDateNDaysAgoInTz(14);

  try {
    const { fetchAdsReport } = await import('@/lib/ads/client');
    const rows = await fetchAdsReport(startDate, endDate);
    if (rows.length === 0) {
      console.log('[manual-sync] background ads-sync: no rows returned');
      return;
    }

    const [asinCount, dailyCount] = await Promise.all([
      upsertAsinAdSpend(rows),
      upsertDailyMarketingSpend(rows),
    ]);

    console.log(
      `[manual-sync] background ads-sync complete: ${asinCount} ASIN rows, ${dailyCount} daily dates`,
    );
  } catch (err) {
    console.error('[manual-sync] background ads-sync failed:', err instanceof Error ? err.message : err);
  }
}

export async function POST() {
  try {
    await migrate();
    await writeSyncStatus('orders:syncing', 'Fetching orders + inventory', false);

    const result = await runSync({ mode: 'today' });

    await writeSyncStatus('orders:done', 'Orders + inventory complete', true);

    // Fire marketing + ads syncs non-blocking after the response is sent.
    void runMarketingSync(2).catch((err) =>
      console.error('[manual-sync] background marketing sync failed:', err instanceof Error ? err.message : err)
    );
    void runAdsSyncBackground();

    const primaryResult = result.results[0];

    return NextResponse.json({
      ok: true,
      date:             result.dates[0],
      orderCount:       primaryResult?.orderCount       ?? 0,
      orderLineCount:   primaryResult?.orderLineCount   ?? 0,
      allocationCount:  primaryResult?.allocationCount  ?? 0,
      unmappedSkuCount: primaryResult?.unmappedSkuCount ?? 0,
      inventorySkuCount: result.inventorySkuCount,
      marketingSync: { ok: true, note: 'running in background' },
      adsSync:       { ok: true, note: 'running in background' },
      vendorSync:    { ok: true, note: 'runs via cron (/api/vendor-sync)' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[/api/manual-sync] Error:', message);
    await writeSyncStatus('error', message, true, message).catch(() => {});
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
