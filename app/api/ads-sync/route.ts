/**
 * POST /api/ads-sync
 *
 * Fetches Amazon Ads API reports (Sponsored Products + Sponsored Brands)
 * and upserts results into:
 *   asin_ad_spend          — per-ASIN daily spend (SP rows only)
 *   daily_marketing_spend  — aggregate daily total (SP + SB combined)
 *
 * Called by the nightly GitHub Actions workflow and the manual Sync button.
 *
 * Date window: trailing 14 days (matching ARA sync window).
 * Auth: Bearer CRON_SECRET header (same pattern as vendor-sync).
 *
 * Environment variables:
 *   AMAZON_ADS_CLIENT_ID       — LWA client id
 *   AMAZON_ADS_CLIENT_SECRET   — LWA client secret
 *   AMAZON_ADS_REFRESH_TOKEN   — long-lived refresh token
 *   AMAZON_ADS_PROFILE_ID      — advertising profile id
 *   CRON_SECRET                — shared bearer secret for cron auth
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // Vercel max; report polling can take ~2 min

import { NextRequest, NextResponse } from 'next/server';
import { getDb, migrate }    from '@/lib/db/turso';
import { fetchAdsReport, AdsReportRow } from '@/lib/ads/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// DB upsert helpers
// ---------------------------------------------------------------------------

/**
 * Upsert per-ASIN SP rows into asin_ad_spend.
 * Skips sentinel "__SB__" rows (SB is campaign-level, not ASIN-level).
 */
async function upsertAsinAdSpend(
  db: ReturnType<typeof getDb>,
  rows: AdsReportRow[],
): Promise<number> {
  const asinRows = rows.filter((r) => r.asin !== '__SB__');
  if (asinRows.length === 0) return 0;

  // Batch in groups of 100 to stay within Turso batch limits
  const BATCH = 100;
  let upserted = 0;

  for (let i = 0; i < asinRows.length; i += BATCH) {
    const chunk = asinRows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `
          INSERT INTO asin_ad_spend
            (asin, report_date, ad_spend, ad_sales, impressions, clicks, acos, campaign_type, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(asin, report_date, campaign_type) DO UPDATE SET
            ad_spend      = excluded.ad_spend,
            ad_sales      = excluded.ad_sales,
            impressions   = excluded.impressions,
            clicks        = excluded.clicks,
            acos          = excluded.acos,
            updated_at    = datetime('now')
        `,
        args: [
          r.asin,
          r.reportDate,
          r.adSpend,
          r.adSales,
          r.impressions,
          r.clicks,
          r.acos,
          r.campaignType,
        ],
      }))
    );
    upserted += chunk.length;
  }

  return upserted;
}

/**
 * Aggregate all rows (SP + SB) by date and upsert into daily_marketing_spend.
 * id format: "YYYY-MM-DD|amazon_vendor"
 *
 * Coupon redemption spend is NOT sourced from the Ads API — it comes from the
 * SP-API coupon report via runMarketingSync. We only update ad_spend here and
 * preserve any existing coupon_redemption_spend already written by marketing-sync.
 */
async function upsertDailyMarketingSpend(
  db: ReturnType<typeof getDb>,
  rows: AdsReportRow[],
): Promise<number> {
  // Group by date — sum ad spend across SP + SB rows
  const byDate = new Map<string, number>();
  for (const r of rows) {
    byDate.set(r.reportDate, (byDate.get(r.reportDate) ?? 0) + r.adSpend);
  }

  if (byDate.size === 0) return 0;

  const entries = [...byDate.entries()];
  await db.batch(
    entries.map(([date, adSpend]) => ({
      sql: `
        INSERT INTO daily_marketing_spend
          (id, date, ad_spend, coupon_redemption_spend, marketplace, updated_at)
        VALUES (?, ?, ?, 0, 'amazon_vendor', unixepoch())
        ON CONFLICT(id) DO UPDATE SET
          ad_spend   = excluded.ad_spend,
          updated_at = unixepoch()
      `,
      // coupon_redemption_spend intentionally NOT updated here — preserved from
      // marketing-sync which populates it via the SP-API coupon report.
      args: [`${date}|amazon_vendor`, date, adSpend],
    }))
  );

  return entries.length;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get('authorization') ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (token !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    await migrate();
    const db = getDb();

    // ── Ensure asin_ad_spend table exists (v15 migration) ──────────────────
    // migrate() handles this but guard here in case deployed before turso.ts bump
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

    // ── Date window: trailing 14 days (matching ARA lag) ───────────────────
    // Amazon Ads data lags ~1 day; we pull 14 days to overlap with ARA window.
    const endDate   = dateNDaysAgo(1);
    const startDate = dateNDaysAgo(14);

    console.log(`[ads-sync] fetching Ads reports ${startDate}→${endDate}`);

    // ── Fetch reports ───────────────────────────────────────────────────────
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

    // ── Upsert ──────────────────────────────────────────────────────────────
    const [asinUpserted, dailyUpserted] = await Promise.all([
      upsertAsinAdSpend(db, rows),
      upsertDailyMarketingSpend(db, rows),
    ]);

    console.log(`[ads-sync] asin_ad_spend upserted=${asinUpserted}, daily_marketing_spend dates=${dailyUpserted}`);

    return NextResponse.json({
      ok:                 true,
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
