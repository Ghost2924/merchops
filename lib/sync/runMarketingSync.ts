/**
 * runMarketingSync — fetches and persists Amazon Vendor promotion data.
 *
 * Pulls ONE Vendor-compatible SP-API Reports API v2021-06-30 report:
 *
 *   GET_PROMOTION_PERFORMANCE_REPORT
 *     → Covers Best Deal, Lightning Deal, and Price Discount promotions
 *       run through Vendor Central.
 *     → parsed per-ASIN → upserted to asin_promotion_metrics
 *     → aggregated discount also upserted to daily_marketing_spend (backward compat)
 *     → Uses standard ARA top-level dataStartTime / dataEndTime.
 *
 * NOTE: GET_VENDOR_NET_RETAIL_PROG_COSTS_REPORT is NOT a real SP-API report
 * type. Co-op / program cost data is not available via the Reports API.
 * GET_COUPON_PERFORMANCE_REPORT is Seller Central-only; do not use with
 * Vendor Central credentials.
 *
 * Idempotent: all upserts use ON CONFLICT DO UPDATE.
 * The caller always receives a structured result regardless of failures.
 *
 * Called by:
 *   POST /api/marketing-sync   (manual trigger, ?days=N param)
 *   lib/sync/runSync.ts        (nightly cron orchestration)
 *
 * Env vars (via getAmazonAccessToken in lib/amazonVendor.ts):
 *   AMAZON_VENDOR_CLIENT_ID
 *   AMAZON_VENDOR_CLIENT_SECRET
 *   AMAZON_VENDOR_REFRESH_TOKEN
 */

import { revalidatePath } from 'next/cache';
import { getDb, migrate } from '@/lib/db/turso';
import { getDateNDaysAgoInTz } from '@/lib/db/queries';
import {
  fetchAndParsePromotionReport,
  PromotionReportRow,
} from '@/lib/spapi/vendor';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarketingSyncResult {
  ok: boolean;
  dateWindow: { startDate: string; endDate: string };
  promotions: {
    ok: boolean;
    rowsUpserted: number;
    error?: string;
  };
  dailyMarketingSpendRows: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// DB upserts
// ---------------------------------------------------------------------------

/**
 * Upsert rows from GET_PROMOTION_PERFORMANCE_REPORT into asin_promotion_metrics.
 */
async function upsertPromotionMetrics(rows: PromotionReportRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  const BATCH = 100;
  let count = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO asin_promotion_metrics
                (asin, promotion_id, report_date, promotion_name, promotion_type,
                 redemptions, discount_amount, sales, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(asin, promotion_id, report_date) DO UPDATE SET
                promotion_name  = excluded.promotion_name,
                promotion_type  = excluded.promotion_type,
                redemptions     = excluded.redemptions,
                discount_amount = excluded.discount_amount,
                sales           = excluded.sales,
                updated_at      = datetime('now')`,
        args: [
          r.asin,
          r.promotion_id,
          r.report_date,
          r.promotion_name || null,
          r.promotion_type || null,
          r.redemptions,
          r.discount_amount,
          r.sales,
        ],
      }))
    );
    count += chunk.length;
  }
  return count;
}

/**
 * Aggregate per-ASIN promotion discount rows into daily_marketing_spend for
 * backward compatibility with vendor-central proportional cost allocation.
 *
 * Groups by report_date, sums discount_amount across all ASINs per day.
 * Writes into the coupon_redemption_spend column (reused for any vendor
 * marketing discount) with marketplace = 'amazon_vendor'.
 */
async function upsertDailyMarketingSpendFromPromotions(
  rows: PromotionReportRow[]
): Promise<number> {
  if (rows.length === 0) return 0;

  const dailyMap = new Map<string, number>();
  for (const r of rows) {
    dailyMap.set(r.report_date, (dailyMap.get(r.report_date) ?? 0) + r.discount_amount);
  }

  const db = getDb();
  const entries = [...dailyMap.entries()];
  const BATCH = 100;
  let count = 0;

  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = entries.slice(i, i + BATCH);
    await db.batch(
      chunk.map(([date, spend]) => ({
        sql: `INSERT INTO daily_marketing_spend
                (id, date, ad_spend, coupon_redemption_spend, marketplace, updated_at)
              VALUES (?, ?, 0, ?, 'amazon_vendor', unixepoch())
              ON CONFLICT(date, marketplace) DO UPDATE SET
                coupon_redemption_spend = excluded.coupon_redemption_spend,
                updated_at              = unixepoch()`,
        args: [`${date}|amazon_vendor`, date, Math.round(spend * 100) / 100],
      }))
    );
    count += chunk.length;
  }

  return count;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export async function runMarketingSync(days = 30): Promise<MarketingSyncResult> {
  await migrate();

  const endDate   = getDateNDaysAgoInTz(0);
  const startDate = getDateNDaysAgoInTz(days - 1);

  console.log(`[marketing-sync] date window: ${startDate} → ${endDate} (${days} days)`);

  const result: MarketingSyncResult = {
    ok: false,
    dateWindow: { startDate, endDate },
    promotions: { ok: false, rowsUpserted: 0 },
    dailyMarketingSpendRows: 0,
  };

  let promotionRows: PromotionReportRow[] = [];

  try {
    promotionRows = await fetchAndParsePromotionReport(startDate, endDate);
    console.log(`[marketing-sync] promotions report: ${promotionRows.length} rows`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[marketing-sync] promotions report fetch failed:', msg);
    result.promotions = { ok: false, rowsUpserted: 0, error: msg };
    result.ok = false;
    return result;
  }

  try {
    const upserted  = await upsertPromotionMetrics(promotionRows);
    const dailyRows = await upsertDailyMarketingSpendFromPromotions(promotionRows);
    result.promotions = { ok: true, rowsUpserted: upserted };
    result.dailyMarketingSpendRows = dailyRows;
    result.ok = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[marketing-sync] upsertPromotionMetrics failed:', msg);
    result.promotions = { ok: false, rowsUpserted: 0, error: msg };
  }

  revalidatePath('/vendor');
  revalidatePath('/');

  console.log(
    `[marketing-sync] complete: promotions=${result.promotions.rowsUpserted} rows, ` +
    `dailySpend=${result.dailyMarketingSpendRows} rows`
  );

  return result;
}
