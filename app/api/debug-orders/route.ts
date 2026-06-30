export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/turso';
import { getTodayInTz, getDateNDaysAgoInTz, getRecentSummaries } from '@/lib/db/queries';

// Debug endpoint for diagnosing dashboard order count vs Teapplix discrepancies.
// Hit GET /api/debug-orders to see a breakdown of what is stored vs what the
// dashboard cache shows, including any cross-date bleed from timezone boundaries.
export async function GET() {
  const db = getDb();
  const today = getTodayInTz();
  const yesterday = getDateNDaysAgoInTz(1);
  const twoDaysAgo = getDateNDaysAgoInTz(2);

  const [recentLines, todayLines, allDates, summaries, crossDateOrders] = await Promise.all([
    // Last 10 order_lines rows regardless of date
    db.execute(`SELECT order_line_id, customer_order_id, order_date, marketplace,
                       raw_storefront_sku, resolved_teapplix_sku, mapping_status, revenue
                FROM order_lines ORDER BY created_at DESC LIMIT 10`),

    // Today's rows specifically
    db.execute({
      sql: `SELECT COUNT(*) AS cnt, COUNT(DISTINCT customer_order_id) AS orders,
                   SUM(revenue) AS revenue,
                   GROUP_CONCAT(DISTINCT mapping_status) AS statuses
            FROM order_lines WHERE order_date = ?`,
      args: [today],
    }),

    // All distinct dates in order_lines (last 10)
    db.execute(`SELECT DISTINCT order_date, COUNT(*) as rows, COUNT(DISTINCT customer_order_id) as orders
                FROM order_lines GROUP BY order_date ORDER BY order_date DESC LIMIT 10`),

    // What getRecentSummaries actually returns for last 3 days
    getRecentSummaries(3),

    // Cross-date bleed check: orders whose order_date differs from today/yesterday by ±1 day.
    // These reveal timezone-boundary orders that previously got dropped by the strict
    // paymentDate === targetDate filter. After the fix, these should now appear.
    db.execute({
      sql: `SELECT order_date,
                   COUNT(DISTINCT customer_order_id) AS orders,
                   COUNT(*) AS line_items,
                   GROUP_CONCAT(DISTINCT customer_order_id) AS sample_order_ids
            FROM order_lines
            WHERE order_date >= ? AND order_date <= ?
            GROUP BY order_date
            ORDER BY order_date DESC`,
      args: [twoDaysAgo, today],
    }),
  ]);

  const todaySummary = summaries.find((s) => s.date === today) ?? null;

  // Per-date breakdown for the last 3 days to make tz-bleed visible
  const dateBreakdown = crossDateOrders.rows.map((r) => ({
    date: r.order_date as string,
    ordersInDb: Number(r.orders),
    lineItemsInDb: Number(r.line_items),
    // Truncate sample IDs to keep response readable
    sampleOrderIds: (r.sample_order_ids as string | null)?.split(',').slice(0, 5) ?? [],
  }));

  return NextResponse.json({
    serverToday: today,
    businessTimezone: process.env.BUSINESS_TIMEZONE ?? 'America/Los_Angeles',
    todayStats: todayLines.rows[0],
    recentDates: allDates.rows,
    recentLines: recentLines.rows,
    summariesLast3: summaries.map((s) => ({ date: s.date, orderCount: s.orderCount, totalRevenue: s.totalRevenue })),
    todaySummaryFound: todaySummary !== null,
    todaySummaryOrderCount: todaySummary?.orderCount ?? null,
    // Key diagnostic: compare todayStats.orders (raw DB count) vs todaySummaryOrderCount (cached).
    // If they differ, the cache is stale — trigger a manual sync to bust it.
    cacheStale: todaySummary !== null && todaySummary.orderCount !== Number(todayLines.rows[0]?.orders ?? 0),
    // Per-date breakdown for spotting tz-boundary bleed (orders landing on adjacent dates)
    dateBreakdownLast3Days: dateBreakdown,
  });
}
