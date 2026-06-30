export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { runSync } from '@/lib/sync/runSync';
import { runMarketingSync } from '@/lib/sync/runMarketingSync';
import { getDb, migrate } from '@/lib/db/turso';

// /api/manual-sync — called by the SyncButton in the dashboard UI.
// Protected by the session cookie middleware — no Bearer token needed.
//
// Blocking: Phase 1 (orders + inventory writes) runs and returns a 200 with results.
// Non-blocking background: marketing sync (coupon/ad spend) + ads-sync (SP+SB reports).
//
// Vendor sync is intentionally NOT triggered here.
// It runs via the existing cron job (nightly-sync.yml → /api/vendor-sync).
// This avoids the ~90s SP-API poll loop inside a Vercel lambda that would get killed.
// The vendor_pending_reports resume table ensures no data is lost between runs.

async function writeSyncStatus(
  phase: string,
  detail: string | null,
  done: boolean,
  error?: string
): Promise<void> {
  try {
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO sync_status (id, phase, detail, done, error, started_at, updated_at)
            VALUES ('current', ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              phase      = excluded.phase,
              detail     = excluded.detail,
              done       = excluded.done,
              error      = excluded.error,
              updated_at = datetime('now')`,
      args: [phase, detail ?? null, done ? 1 : 0, error ?? null],
    });
  } catch {
    // Non-fatal
  }
}

// Background ads-sync: fetches SP+SB reports and upserts into asin_ad_spend
// + daily_marketing_spend. Same 14-day window as the nightly cron.
// Uses dynamic import to avoid bundling the ads client into the main lambda chunk.
async function runAdsSyncBackground(): Promise<void> {
  const now = new Date();
  const fmt = (n: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const endDate   = fmt(1);
  const startDate = fmt(14);

  try {
    const { fetchAdsReport } = await import('@/lib/ads/client');
    const rows = await fetchAdsReport(startDate, endDate);
    if (rows.length === 0) {
      console.log('[manual-sync] background ads-sync: no rows returned');
      return;
    }

    const db = getDb();

    // Upsert per-ASIN SP rows into asin_ad_spend
    const asinRows = rows.filter((r) => r.asin !== '__SB__');
    const BATCH = 100;
    for (let i = 0; i < asinRows.length; i += BATCH) {
      const chunk = asinRows.slice(i, i + BATCH);
      await db.batch(chunk.map((r) => ({
        sql: `INSERT INTO asin_ad_spend
                (asin, report_date, ad_spend, ad_sales, impressions, clicks, acos, campaign_type, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(asin, report_date, campaign_type) DO UPDATE SET
                ad_spend    = excluded.ad_spend,
                ad_sales    = excluded.ad_sales,
                impressions = excluded.impressions,
                clicks      = excluded.clicks,
                acos        = excluded.acos,
                updated_at  = datetime('now')`,
        args: [r.asin, r.reportDate, r.adSpend, r.adSales, r.impressions, r.clicks, r.acos, r.campaignType],
      })));
    }

    // Upsert daily totals into daily_marketing_spend.
    // Preserve coupon_redemption_spend already written by marketing-sync — only update ad_spend.
    const byDate = new Map<string, number>();
    for (const r of rows) byDate.set(r.reportDate, (byDate.get(r.reportDate) ?? 0) + r.adSpend);
    await db.batch([...byDate.entries()].map(([date, adSpend]) => ({
      sql: `INSERT INTO daily_marketing_spend
              (id, date, ad_spend, coupon_redemption_spend, marketplace, updated_at)
            VALUES (?, ?, ?, 0, 'amazon_vendor', unixepoch())
            ON CONFLICT(id) DO UPDATE SET
              ad_spend   = excluded.ad_spend,
              updated_at = unixepoch()`,
      args: [`${date}|amazon_vendor`, date, adSpend],
    })));

    console.log(
      `[manual-sync] background ads-sync complete: ${asinRows.length} ASIN rows, ${byDate.size} daily dates`
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

    // Fire marketing sync + ads sync AFTER response — both non-blocking.
    void runMarketingSync(2).catch((err) =>
      console.error('[manual-sync] background marketing sync failed:', err instanceof Error ? err.message : err)
    );
    void runAdsSyncBackground();

    const primaryResult = result.results[0];

    return NextResponse.json({
      ok: true,
      date: result.dates[0],
      orderCount: primaryResult?.orderCount ?? 0,
      orderLineCount: primaryResult?.orderLineCount ?? 0,
      allocationCount: primaryResult?.allocationCount ?? 0,
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
