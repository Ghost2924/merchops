/**
 * POST /api/ads-sync
 *
 * Fetches Amazon Ads API reports (Sponsored Products + Sponsored Brands)
 * and upserts into asin_ad_spend + daily_marketing_spend.
 * Date window: trailing 14 days. Auth: Bearer CRON_SECRET.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { getDb, migrate } from '@/lib/db/turso';
import { fetchAdsReport } from '@/lib/ads/client';
import { upsertAsinAdSpend, upsertDailyMarketingSpend } from '@/lib/db/ads-queries';
import { cronGuard } from '@/lib/auth/cronGuard';
import { getDateNDaysAgoInTz } from '@/lib/db/queries';

export async function POST(req: NextRequest) {
  const deny = cronGuard(req);
  if (deny) return deny;

  try {
    await migrate();
    const db = getDb();

    // Ensure asin_ad_spend table exists (v15 migration guard)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS asin_ad_spend (
        asin          TEXT    NOT NULL,
        report_date   TEXT    NOT NULL,
        ad_spend      REAL    NOT NULL DEFAULT 0.0,
        ad_sales      REAL    NOT NULL DEFAULT 0.0,
        impressions   INTEGER NOT NULL DEFAULT 0,
        clicks        INTEGER NOT NULL DEFAULT 0,
        acos          REAL,
        campaign_type TEXT    NOT NULL DEFAULT 'SP',
        updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (asin, report_date, campaign_type)
      )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_aas_asin        ON asin_ad_spend (asin)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_aas_report_date ON asin_ad_spend (report_date)`);

    const endDate   = getDateNDaysAgoInTz(1);
    const startDate = getDateNDaysAgoInTz(14);

    console.log(`[ads-sync] fetching Ads reports ${startDate}→${endDate}`);
    const rows = await fetchAdsReport(startDate, endDate);
    console.log(`[ads-sync] total rows fetched: ${rows.length}`);

    if (rows.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'No ad spend rows returned (credentials may not be configured)',
        asinRowsUpserted: 0,
        dailyDatesUpserted: 0,
      });
    }

    const [asinUpserted, dailyUpserted] = await Promise.all([
      upsertAsinAdSpend(rows),
      upsertDailyMarketingSpend(rows),
    ]);

    console.log(`[ads-sync] asin_ad_spend upserted=${asinUpserted}, daily_marketing_spend dates=${dailyUpserted}`);

    return NextResponse.json({
      ok: true,
      startDate,
      endDate,
      asinRowsUpserted:   asinUpserted,
      dailyDatesUpserted: dailyUpserted,
      totalRowsFromApi:   rows.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ads-sync]', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
