/**
 * lib/db/ads-queries.ts
 *
 * Shared DB helpers for Amazon Ads data.
 * Single authoritative copy — used by ads-sync, ads-backfill, and manual-sync.
 */

import { getDb } from './turso';
import type { AdsReportRow } from '@/lib/ads/client';

const BATCH = 100;

/**
 * Upsert per-ASIN SP rows into asin_ad_spend.
 * Skips sentinel "__SB__" rows (SB is campaign-level, not ASIN-level).
 */
export async function upsertAsinAdSpend(
  rows: AdsReportRow[],
): Promise<number> {
  const asinRows = rows.filter((r) => r.asin !== '__SB__');
  if (asinRows.length === 0) return 0;

  const db = getDb();
  let upserted = 0;

  for (let i = 0; i < asinRows.length; i += BATCH) {
    const chunk = asinRows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
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
      }))
    );
    upserted += chunk.length;
  }

  return upserted;
}

/**
 * Aggregate all rows (SP + SB) by date and upsert into daily_marketing_spend.
 *
 * Preserves any existing coupon_redemption_spend — only updates ad_spend.
 * id format: "YYYY-MM-DD|amazon_vendor"
 */
export async function upsertDailyMarketingSpend(
  rows: AdsReportRow[],
): Promise<number> {
  const byDate = new Map<string, number>();
  for (const r of rows) {
    byDate.set(r.reportDate, (byDate.get(r.reportDate) ?? 0) + r.adSpend);
  }
  if (byDate.size === 0) return 0;

  const db = getDb();
  const entries = [...byDate.entries()];

  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = entries.slice(i, i + BATCH);
    await db.batch(
      chunk.map(([date, adSpend]) => ({
        sql: `INSERT INTO daily_marketing_spend
                (id, date, ad_spend, coupon_redemption_spend, marketplace, updated_at)
              VALUES (?, ?, ?, 0, 'amazon_vendor', unixepoch())
              ON CONFLICT(id) DO UPDATE SET
                ad_spend   = excluded.ad_spend,
                updated_at = unixepoch()`,
        args: [`${date}|amazon_vendor`, date, adSpend],
      }))
    );
  }

  return entries.length;
}
