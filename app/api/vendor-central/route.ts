/**
 * GET /api/vendor-central
 *
 * Returns aggregated ARA KPIs + per-ASIN table data for the Vendor Central page.
 *
 * Query params:
 *   period  = 7 | 30 | 90 | 365  (days, default 30)
 *
 * Data: vendor_ara_metrics joined to sku_mappings (ASIN → model_number),
 *       vendor_inventory_health (latest ROOS %), asin_ad_spend for ad spend,
 *       asin_promotion_metrics (GET_PROMOTION_PERFORMANCE_REPORT) for per-ASIN
 *         promotion discount spend (Best Deal, Lightning Deal, Price Discount),
 *       daily_marketing_spend fallback for proportional allocation when no
 *         promotion data exists for the period.
 *
 * NOTE: There is no SP-API report type for vendor co-op / net retail program
 * costs. Promotion discount from GET_PROMOTION_PERFORMANCE_REPORT is the only
 * vendor marketing cost available via the Reports API.
 *
 * NOTE: ARA data lags ~4 days — not comparable to real-time Teapplix orders.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb, migrate } from '@/lib/db/turso';
import { fetchAsinTitles } from '@/lib/spapi/catalog';
import { normalizeSku, parsePack } from '@/lib/sku/resolver';

export const dynamic = 'force-dynamic';

function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const periodDays = parseInt(searchParams.get('period') ?? '30', 10);
  const validPeriods = [7, 30, 90, 365];
  const days = validPeriods.includes(periodDays) ? periodDays : 30;

  // ARA data lags ~4 days, but the actual lag varies — the newest rows in DB
  // may be older than today-4 when vendor sync hasn't run recently.
  // Use the actual newest ARA date from the DB as the window ceiling so periods
  // always overlap real data instead of sitting in the lag gap.
  // Fallback to today-4 on first load before any ARA data exists.
  //
  // We compute this below after the availResult query and reconstruct windows.
  const fallbackEnd   = dateNDaysAgo(4);

  try {
    await migrate();
    const db = getDb();
    const dbUrl = process.env.TURSO_DATABASE_URL ?? '(unknown)';

    // One-time backfill: normalize any 'DAILY' rows (Amazon raw) → 'DAY' (our canonical value)
    // Safe to run every request — no-op after first time since no 'DAILY' rows remain
    await db.execute(
      `UPDATE vendor_ara_metrics SET period_type = 'DAY' WHERE period_type = 'DAILY'`
    ).catch((e) => console.warn('[vendor-central] backfill DAILY→DAY failed:', e));

    // ── How many days of data actually exist? ───────────────────────────────
    // Used by the client to label periods as "partial" when requested window
    // exceeds what was synced (sync only pulls trailing ~14 days).
    const availResult = await db.execute({
      sql: `SELECT MIN(period_start) AS oldest, MAX(period_start) AS newest
            FROM vendor_ara_metrics
            WHERE period_type IN ('DAY', 'DAILY')`,
      args: [],
    });
    const avRow = availResult.rows[0];
    let dataAvailableDays: number | null = null;
    // Use actual newest ARA date as window ceiling so the query always lands on real data.
    // Falls back to today-4 when no ARA data exists yet.
    const currentEnd = (avRow?.newest as string | null) ?? fallbackEnd;
    // Recalculate currentStart relative to currentEnd so the window width = days.
    const currentEndDate = new Date(currentEnd);
    const rebasedStart = new Date(currentEndDate);
    rebasedStart.setDate(rebasedStart.getDate() - days);
    const currentStartFinal = rebasedStart.toISOString().slice(0, 10);
    // priorStart stays relative to currentStartFinal
    const priorStartDate = new Date(rebasedStart);
    priorStartDate.setDate(priorStartDate.getDate() - days);
    const priorStartFinal = priorStartDate.toISOString().slice(0, 10);

    if (avRow?.oldest && avRow?.newest) {
      const oldest = new Date(avRow.oldest as string);
      const newest = new Date(avRow.newest as string);
      const diffMs = newest.getTime() - oldest.getTime();
      dataAvailableDays = Math.round(diffMs / 86_400_000) + 1;
    }

    // ── Per-ASIN aggregation for current period ─────────────────────────────
    // Aggregate DAY rows over the window; join sku_mappings for model_number
    // (source_sku = ASIN, marketplace = 'amazon_vendor' or any).
    // Latest ROOS from vendor_inventory_health.
    // Ad spend from asin_ad_spend (LEFT JOIN — gracefully absent when not synced).
    // Diagnostic: log total row count in vendor_ara_metrics for the window
    const diagResult = await db.execute({
      sql: `SELECT COUNT(*) as total, COUNT(DISTINCT period_type) as type_count,
                   GROUP_CONCAT(DISTINCT period_type) as period_types,
                   COUNT(DISTINCT asin) as asin_count
            FROM vendor_ara_metrics
            WHERE period_start >= ? AND period_start <= ?`,
      args: [currentStartFinal, currentEnd],
    });
    const diag = diagResult.rows[0];
    console.log(
      `[vendor-central] DB window=${currentStartFinal}→${currentEnd} ` +
      `total_rows=${diag?.total} asins=${diag?.asin_count} ` +
      `period_types="${diag?.period_types}" type_count=${diag?.type_count}`
    );

    const asinResult = await db.execute({
      sql: `
        WITH ara AS (
          SELECT
            asin,
            SUM(shipped_revenue)  AS shipped_revenue,
            SUM(shipped_cogs)     AS shipped_cogs,
            SUM(ordered_units)    AS ordered_units,
            SUM(sales_discount)   AS sales_discount,
            -- Revenue-weighted net_ppm: sum(net_ppm * shipped_revenue) / sum(shipped_revenue)
            CASE
              WHEN SUM(CASE WHEN net_ppm IS NOT NULL THEN shipped_revenue ELSE 0 END) > 0
              THEN SUM(COALESCE(net_ppm, 0) * COALESCE(shipped_revenue, 0))
                   / SUM(CASE WHEN net_ppm IS NOT NULL THEN shipped_revenue ELSE 0 END)
              ELSE NULL
            END AS net_ppm_weighted
          FROM vendor_ara_metrics
          WHERE period_start >= ?
            AND period_start <= ?
            -- Accept both 'DAY' (normalized) and 'DAILY' (Amazon raw) to handle existing rows
            AND period_type IN ('DAY', 'DAILY')
          GROUP BY asin
        ),
        health AS (
          -- Average ROOS across all snapshots within the query window (period-avg, not latest-only)
          SELECT asin, AVG(roos_percent) AS roos_percent
          FROM vendor_inventory_health
          WHERE snapshot_date >= ? AND snapshot_date <= ?
            AND roos_percent IS NOT NULL
          GROUP BY asin
        ),
        ads AS (
          -- Per-ASIN ad spend aggregated over the same window as ARA.
          SELECT
            asin,
            SUM(ad_spend)    AS ad_spend,
            SUM(ad_sales)    AS ad_sales,
            SUM(clicks)      AS clicks,
            SUM(impressions) AS impressions
          FROM asin_ad_spend
          WHERE report_date >= ? AND report_date <= ?
            AND asin != '__SB__'
          GROUP BY asin
        ),
        sb_spend AS (
          -- Sponsored Brands total spend for the window.
          SELECT COALESCE(SUM(ad_spend), 0) AS total_sb_spend
          FROM asin_ad_spend
          WHERE report_date >= ? AND report_date <= ?
            AND asin = '__SB__'
        ),
        -- ── Promotion discount: direct per-ASIN from asin_promotion_metrics (preferred) ──
        -- Populated by POST /api/marketing-sync → GET_PROMOTION_PERFORMANCE_REPORT.
        -- Covers Best Deal, Lightning Deal, and Price Discount promotions.
        -- Falls back to proportional daily_marketing_spend allocation below
        -- when this table has no rows for the period.
        coupon_direct AS (
          SELECT
            asin,
            SUM(discount_amount) AS coupon_spend,
            SUM(redemptions)     AS redemptions,
            SUM(sales)           AS coupon_sales
          FROM asin_promotion_metrics
          WHERE report_date >= ? AND report_date <= ?
          GROUP BY asin
        ),
        -- ── Promo spend fallback: proportional allocation from daily_marketing_spend ──
        -- Used only when asin_promotion_metrics has no data (marketing-sync not yet run).
        -- total_coupon_spend is distributed in proportion to each ASIN's shipped_revenue.
        coupon_fallback AS (
          SELECT COALESCE(SUM(coupon_redemption_spend), 0) AS total_coupon_spend
          FROM daily_marketing_spend
          WHERE date >= ? AND date <= ?
            AND marketplace = 'amazon_vendor'
        ),
        -- ── Per-ASIN promotion spend (redundant join kept for backward compat) ───
        -- promo_direct mirrors coupon_direct; retained so existing SELECT columns
        -- (promotion_spend, promo_redemptions) continue to resolve without change.
        promo_direct AS (
          SELECT
            asin,
            SUM(discount_amount) AS promotion_spend,
            SUM(redemptions)     AS promo_redemptions,
            SUM(sales)           AS promo_sales
          FROM asin_promotion_metrics
          WHERE report_date >= ? AND report_date <= ?
          GROUP BY asin
        ),
        -- Flag: does asin_promotion_metrics have ANY rows for this period?
        -- Used in the SELECT to choose direct vs proportional fallback.
        coupon_data_exists AS (
          SELECT COUNT(*) AS cnt
          FROM asin_promotion_metrics
          WHERE report_date >= ? AND report_date <= ?
        ),
        titles AS (
          SELECT asin, MAX(title) AS title
          FROM (
            SELECT asin, title FROM inventory_products WHERE asin IS NOT NULL AND asin != ''
            UNION ALL
            SELECT asin, title FROM combo_products WHERE asin IS NOT NULL AND asin != ''
            UNION ALL
            SELECT sm.source_sku AS asin, ip.title
            FROM sku_mappings sm
            JOIN inventory_products ip ON ip.sku = sm.teapplix_sku
            WHERE sm.active = 1
              AND ip.title IS NOT NULL AND ip.title != ''
            UNION ALL
            SELECT sm.source_sku AS asin, cp.title
            FROM sku_mappings sm
            JOIN combo_products cp ON cp.sku = sm.teapplix_sku
            WHERE sm.active = 1
              AND cp.title IS NOT NULL AND cp.title != ''
          )
          GROUP BY asin
        ),
        mappings AS (
          SELECT source_sku AS asin, MIN(teapplix_sku) AS teapplix_sku
          FROM sku_mappings
          WHERE active = 1
          GROUP BY source_sku
        )
        SELECT
          ara.asin,
          COALESCE(mappings.teapplix_sku, '—') AS teapplix_sku,
          COALESCE(titles.title, '')            AS title,
          ara.shipped_revenue,
          ara.shipped_cogs,
          ara.ordered_units,
          ara.sales_discount,
          ara.net_ppm_weighted                  AS net_ppm,
          health.roos_percent,
          COALESCE(ads.ad_spend, 0)             AS ad_spend,
          COALESCE(ads.ad_sales, 0)             AS ad_sales,

          -- ── Promotion discount (preferred: direct per-ASIN; fallback: proportional) ──
          -- When asin_promotion_metrics has data for this period, use it directly.
          -- Otherwise fall back to revenue-proportional allocation from daily totals.
          CASE
            WHEN (SELECT cnt FROM coupon_data_exists) > 0
            THEN COALESCE(coupon_direct.coupon_spend, 0)
            WHEN (SELECT total_coupon_spend FROM coupon_fallback) > 0
             AND ara.shipped_revenue > 0
             AND (SELECT SUM(shipped_revenue) FROM ara) > 0
            THEN (SELECT total_coupon_spend FROM coupon_fallback)
                 * ara.shipped_revenue
                 / (SELECT SUM(shipped_revenue) FROM ara)
            ELSE 0
          END AS coupon_spend,

          -- ── Promotion redemptions (direct only; NULL when using fallback) ──────
          CASE
            WHEN (SELECT cnt FROM coupon_data_exists) > 0
            THEN coupon_direct.redemptions
            ELSE NULL
          END AS coupon_redemptions,

          -- ── Promotion spend: per-ASIN discount total from SP-API report ──────
          COALESCE(promo_direct.promotion_spend, 0)  AS promotion_spend,
          promo_direct.promo_redemptions             AS promo_redemptions,

          -- ── ACOS: ad_spend / ad_sales * 100 (NULL when no ad_sales) ─────────
          CASE
            WHEN COALESCE(ads.ad_sales, 0) > 0
            THEN (COALESCE(ads.ad_spend, 0) / ads.ad_sales) * 100
            ELSE NULL
          END AS acos,

          -- ── Contribution PPM %: includes promotion discount friction ────────────
          -- Formula: (Revenue − COGS − Ad Spend − Promotion Discount Spend)
          --          / Revenue × 100
          CASE
            WHEN ara.shipped_revenue > 0
            THEN (
              ara.shipped_revenue
              - COALESCE(ara.shipped_cogs, 0)
              - COALESCE(ads.ad_spend, 0)
              -- promotion discount: same direct/fallback logic as coupon_spend above
              - CASE
                  WHEN (SELECT cnt FROM coupon_data_exists) > 0
                  THEN COALESCE(coupon_direct.coupon_spend, 0)
                  WHEN (SELECT total_coupon_spend FROM coupon_fallback) > 0
                   AND (SELECT SUM(shipped_revenue) FROM ara) > 0
                  THEN (SELECT total_coupon_spend FROM coupon_fallback)
                       * ara.shipped_revenue
                       / (SELECT SUM(shipped_revenue) FROM ara)
                  ELSE 0
                END
            ) / ara.shipped_revenue * 100
            ELSE NULL
          END AS contribution_ppm
        FROM ara
        LEFT JOIN mappings     ON mappings.asin     = ara.asin
        LEFT JOIN titles       ON titles.asin       = ara.asin
        LEFT JOIN health       ON health.asin       = ara.asin
        LEFT JOIN ads          ON ads.asin          = ara.asin
        LEFT JOIN coupon_direct ON coupon_direct.asin = ara.asin
        LEFT JOIN promo_direct  ON promo_direct.asin  = ara.asin
        ORDER BY ara.shipped_revenue DESC NULLS LAST
      `,
      args: [
        currentStartFinal, currentEnd,   // ara window
        currentStartFinal, currentEnd,   // health window
        currentStartFinal, currentEnd,   // ads window
        currentStartFinal, currentEnd,   // sb_spend window
        currentStartFinal, currentEnd,   // coupon_direct window
        currentStartFinal, currentEnd,   // coupon_fallback window
        currentStartFinal, currentEnd,   // promo_direct window
        currentStartFinal, currentEnd,   // coupon_data_exists window
      ],
    });

    // ── Prior period totals for KPI deltas ──────────────────────────────────
    const priorResult = await db.execute({
      sql: `
        SELECT
          SUM(shipped_revenue) AS shipped_revenue,
          SUM(sales_discount)  AS sales_discount,
          SUM(ordered_units)   AS ordered_units,
          CASE
            WHEN SUM(CASE WHEN net_ppm IS NOT NULL THEN shipped_revenue ELSE 0 END) > 0
            THEN SUM(COALESCE(net_ppm, 0) * COALESCE(shipped_revenue, 0))
                 / SUM(CASE WHEN net_ppm IS NOT NULL THEN shipped_revenue ELSE 0 END)
            ELSE NULL
          END AS net_ppm_weighted
        FROM vendor_ara_metrics
        WHERE period_start >= ?
          AND period_start < ?
          AND period_type IN ('DAY', 'DAILY')
      `,
      args: [priorStartFinal, currentStartFinal],
    });

    // Prior-period ad spend for delta calculation
    const priorAdResult = await db.execute({
      sql: `SELECT COALESCE(SUM(ad_spend), 0) AS ad_spend
            FROM asin_ad_spend
            WHERE report_date >= ? AND report_date < ?
              AND asin != '__SB__'`,
      args: [priorStartFinal, currentStartFinal],
    }).catch(() => ({ rows: [{ ad_spend: null }] }));

    // ── Parse ASIN rows ──────────────────────────────────────────────────────
    type AsinRow = {
      asin: string;
      teapplix_sku: string;
      title: string;
      shipped_revenue: number | null;
      shipped_cogs: number | null;
      ordered_units: number | null;
      raw_ordered_units: number | null;  // ARA order count before pack multiply
      pack_qty: number | null;           // pack multiplier applied (null if 1)
      sales_discount: number | null;
      net_ppm: number | null;
      roos_percent: number | null;
      ad_spend: number | null;
      ad_sales: number | null;
      coupon_spend: number | null;
      coupon_redemptions: number | null;  // direct from asin_coupon_metrics; null = fallback used
      promotion_spend: number | null;     // from asin_promotion_metrics
      promo_redemptions: number | null;   // from asin_promotion_metrics
      acos: number | null;
      contribution_ppm: number | null;
    };

    const asins: AsinRow[] = asinResult.rows.map((r) => ({
      asin:                r.asin as string,
      teapplix_sku:        (r.teapplix_sku as string) ?? '—',
      title:               (r.title as string) ?? '',
      shipped_revenue:     r.shipped_revenue    != null ? Number(r.shipped_revenue)    : null,
      shipped_cogs:        r.shipped_cogs       != null ? Number(r.shipped_cogs)       : null,
      ordered_units:       r.ordered_units      != null ? Number(r.ordered_units)      : null,
      raw_ordered_units:   null,
      pack_qty:            null,
      sales_discount:      r.sales_discount     != null ? Number(r.sales_discount)     : null,
      net_ppm:             r.net_ppm            != null ? Number(r.net_ppm)            : null,
      roos_percent:        r.roos_percent       != null ? Number(r.roos_percent)       : null,
      ad_spend:            r.ad_spend           != null ? Number(r.ad_spend)           : null,
      ad_sales:            r.ad_sales           != null ? Number(r.ad_sales)           : null,
      coupon_spend:        r.coupon_spend       != null ? Number(r.coupon_spend)       : null,
      coupon_redemptions:  r.coupon_redemptions != null ? Number(r.coupon_redemptions) : null,
      promotion_spend:     r.promotion_spend    != null ? Number(r.promotion_spend)    : null,
      promo_redemptions:   r.promo_redemptions  != null ? Number(r.promo_redemptions)  : null,
      acos:                r.acos               != null ? Number(r.acos)               : null,
      contribution_ppm:    r.contribution_ppm   != null ? Number(r.contribution_ppm)   : null,
    }));

    console.log(`[vendor-central] query returned ${asins.length} ASIN rows`);

    // ── Apply pack multiplier to ordered_units ───────────────────────────────
    // ARA reports ordered_units as boxes/packs (1 unit = 1 listing sold).
    // Multiply by pack qty from teapplix_sku so we show total individual chairs/items.
    // e.g. ASIN → "5234-10-HEAVY-HEAVY": packQty=10, 264 boxes → 2640 chairs.
    // Strip trailing all-caps qualifiers (same logic as client familyKey) before parsePack.
    // raw_ordered_units preserved = original ARA order count (boxes/listings).
    for (const row of asins) {
      if (row.teapplix_sku && row.teapplix_sku !== '—' && row.ordered_units != null) {
        const normalized = normalizeSku(row.teapplix_sku).replace(/((?:-[A-Z]{2,})+)$/, '');
        const { qty: packQty } = parsePack(normalized);
        if (packQty > 1) {
          row.raw_ordered_units = row.ordered_units;
          row.pack_qty = packQty;
          row.ordered_units = row.ordered_units * packQty;
        }
      }
    }

    // ── Catalog Items API fallback for ASINs still missing a title ───────────
    // 1. Check asin_title_cache first (populated from previous API fetches).
    // 2. Only call SP-API for ASINs not in cache — cap at 50 to stay within rate limits.
    // 3. Persist newly fetched titles to cache so next page load skips the API call.
    const blankTitleAsins = asins
      .filter((r) => !r.title)
      .map((r) => r.asin);

    if (blankTitleAsins.length > 0) {
      // Step 1: read from DB cache
      try {
        const placeholders = blankTitleAsins.map(() => '?').join(',');
        const cacheResult = await db.execute({
          sql: `SELECT asin, title FROM asin_title_cache WHERE asin IN (${placeholders})`,
          args: blankTitleAsins,
        });
        for (const row of asins) {
          if (!row.title) {
            const cached = cacheResult.rows.find((c) => c.asin === row.asin);
            if (cached?.title) row.title = cached.title as string;
          }
        }
        console.log(`[vendor-central] cache hit ${cacheResult.rows.length}/${blankTitleAsins.length} titles`);
      } catch (cacheErr) {
        console.warn('[vendor-central] asin_title_cache read failed:', cacheErr);
      }

      // Step 2: fetch remaining blanks from SP-API (cap at 50)
      const stillBlank = asins
        .filter((r) => !r.title)
        .map((r) => r.asin)
        .slice(0, 50);

      if (stillBlank.length > 0) {
        console.log(
          `[vendor-central] fetching ${stillBlank.length} titles from Catalog Items API`
        );
        try {
          const apiTitles = await fetchAsinTitles(stillBlank);
          for (const row of asins) {
            if (!row.title && apiTitles.has(row.asin)) {
              row.title = apiTitles.get(row.asin)!;
            }
          }
          console.log(`[vendor-central] Catalog API resolved ${apiTitles.size} titles`);

          // Step 3: persist newly fetched titles to cache
          if (apiTitles.size > 0) {
            const entries = [...apiTitles.entries()];
            await db.batch(
              entries.map(([asin, title]) => ({
                sql: `INSERT INTO asin_title_cache (asin, title, fetched_at)
                      VALUES (?, ?, datetime('now'))
                      ON CONFLICT(asin) DO UPDATE SET
                        title      = excluded.title,
                        fetched_at = datetime('now')`,
                args: [asin, title],
              }))
            ).catch((e) => console.warn('[vendor-central] asin_title_cache write failed:', e));
          }
        } catch (err) {
          // Non-fatal: titles stay blank, don't fail the whole response
          console.warn('[vendor-central] Catalog Items API title fetch failed:', err);
        }
      }
    }

    // ── Aggregate current KPIs ───────────────────────────────────────────────
    let totalRevenue    = 0;
    let totalDiscount   = 0;
    let totalUnits      = 0;
    let wtRevForPpm     = 0;
    let wtPpmNum        = 0;
    let roosCount       = 0;
    let roosSum         = 0;
    let totalAdSpend    = 0;
    let totalAdSales    = 0;
    let totalCoupon     = 0;
    let totalPromo      = 0;
    let acosCount       = 0;
    let highAcosCount   = 0;   // ASINs where ACOS ≥ 45%

    for (const r of asins) {
      totalRevenue  += r.shipped_revenue  ?? 0;
      totalDiscount += r.sales_discount   ?? 0;
      totalUnits    += r.ordered_units    ?? 0;
      if (r.net_ppm != null && r.shipped_revenue != null) {
        wtPpmNum    += r.net_ppm * r.shipped_revenue;
        wtRevForPpm += r.shipped_revenue;
      }
      if (r.roos_percent != null) {
        roosSum   += r.roos_percent;
        roosCount += 1;
      }
      totalAdSpend += r.ad_spend        ?? 0;
      totalAdSales += r.ad_sales        ?? 0;
      totalCoupon  += r.coupon_spend    ?? 0;
      totalPromo   += r.promotion_spend ?? 0;
      if (r.acos != null) {
        acosCount++;
        if (r.acos >= 45) highAcosCount++;
      }
    }

    const currentNetPpm = wtRevForPpm > 0 ? wtPpmNum / wtRevForPpm : null;
    const avgRoos       = roosCount   > 0 ? roosSum / roosCount     : null;
    // ROAS = total ad sales / total ad spend (null when no ad spend synced)
    const roas          = totalAdSpend > 0 ? totalAdSales / totalAdSpend : null;

    // ── Prior period KPIs ────────────────────────────────────────────────────
    const pr = priorResult.rows[0];
    const priorRevenue  = pr?.shipped_revenue != null ? Number(pr.shipped_revenue) : null;
    const priorDiscount = pr?.sales_discount  != null ? Number(pr.sales_discount)  : null;
    const priorNetPpm   = pr?.net_ppm_weighted != null ? Number(pr.net_ppm_weighted) : null;
    const priorAdSpend  = priorAdResult.rows[0]?.ad_spend != null
      ? Number(priorAdResult.rows[0].ad_spend)
      : null;

    function pctChange(cur: number, prior: number | null): number | null {
      if (prior == null || prior === 0) return null;
      return ((cur - prior) / Math.abs(prior)) * 100;
    }

    const kpis = {
      shipped_revenue:       totalRevenue,
      shipped_revenue_delta: pctChange(totalRevenue, priorRevenue),
      net_ppm:               currentNetPpm,
      net_ppm_delta:         currentNetPpm != null && priorNetPpm != null
                               ? currentNetPpm - priorNetPpm   // pp change, not %
                               : null,
      sales_discount:        totalDiscount,
      sales_discount_delta:  pctChange(totalDiscount, priorDiscount),
      avg_roos:              avgRoos,
      // ── Ad spend KPIs ──────────────────────────────────────────────────
      total_ad_spend:        totalAdSpend,
      total_ad_spend_delta:  pctChange(totalAdSpend, priorAdSpend),
      total_coupon_spend:    totalCoupon,
      total_promotion_spend: totalPromo,
      roas:                  roas,              // ad_sales / ad_spend
      high_acos_count:       highAcosCount,     // ASINs ACOS ≥ 45%
    };

    // roosDataAvailable = false means vendor_inventory_health has no roos_percent
    // data for the period — likely SOURCING view not provisioned for this account.
    // Client uses this to hide ROOS column/card rather than show "—" everywhere.
    const roosDataAvailable = roosCount > 0;

    // salesDiscountDataAvailable = false when every ASIN has null or zero sales_discount.
    // Rather than show a "$0.00" KPI card and a column of "—" / "$0.00" rows,
    // hide both entirely. The flag mirrors the roosDataAvailable pattern.
    const salesDiscountDataAvailable = asins.some(
      (r) => r.sales_discount != null && r.sales_discount !== 0
    );

    // adSpendDataAvailable = false when no ad spend rows exist for the period.
    // Hides ad spend KPI cards and table columns to avoid cluttering the UI
    // with empty $0 columns before the Ads API has been synced.
    const adSpendDataAvailable = totalAdSpend > 0;

    // couponDataAvailable = true when asin_coupon_metrics has rows for the period.
    // When false, coupon_spend in each ASIN row is the proportional fallback.
    const couponDataAvailable = asins.some(
      (r) => r.coupon_redemptions != null
    );

    // promotionDataAvailable = true when asin_promotion_metrics has rows for the period.
    // When false, promotion_spend is 0 for all rows (marketing-sync not yet run).
    const promotionDataAvailable = totalPromo > 0;

    return NextResponse.json({
      period: days,
      currentStart: currentStartFinal,
      currentEnd,
      dataAvailableDays,
      roosDataAvailable,
      salesDiscountDataAvailable,
      adSpendDataAvailable,
      couponDataAvailable,
      promotionDataAvailable,
      kpis,
      asins,
      _db: dbUrl,
      _debug: {
        totalDbRows: diag?.total,
        asinCount: diag?.asin_count,
        periodTypes: diag?.period_types,
        queryAsinCount: asins.length,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[vendor-central API]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
