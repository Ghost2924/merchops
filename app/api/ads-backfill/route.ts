/**
 * POST /api/ads-backfill
 *
 * Fetches historical Amazon Ads SP reports in 30-day chunks and upserts
 * into asin_ad_spend + daily_marketing_spend.
 *
 * Body: { startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD", chunkDays?: number }
 * Auth: Bearer CRON_SECRET.
 *
 * Note: a full year (~12 chunks × ~2 min each) exceeds Vercel's 5-min limit.
 * Run locally (npm run dev + curl) or via a long-running job.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { migrate } from '@/lib/db/turso';
import { fetchAdsReport } from '@/lib/ads/client';
import { upsertAsinAdSpend, upsertDailyMarketingSpend } from '@/lib/db/ads-queries';
import { cronGuard } from '@/lib/auth/cronGuard';

/** Split [startDate, endDate] into chunks of at most chunkDays days each. */
function dateChunks(
  startDate: string,
  endDate: string,
  chunkDays: number,
): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  let cursor = new Date(startDate);
  const last = new Date(endDate);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  while (cursor <= last) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + chunkDays - 1);
    if (chunkEnd > last) chunkEnd.setTime(last.getTime());
    chunks.push({ start: fmt(cursor), end: fmt(chunkEnd) });
    cursor = new Date(chunkEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  return chunks;
}

export async function POST(req: NextRequest) {
  const deny = cronGuard(req);
  if (deny) return deny;

  let body: { startDate?: string; endDate?: string; chunkDays?: number } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { startDate, endDate, chunkDays = 30 } = body;

  if (!startDate || !endDate) {
    return NextResponse.json(
      { error: 'startDate and endDate are required (YYYY-MM-DD)' },
      { status: 400 },
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return NextResponse.json({ error: 'Dates must be YYYY-MM-DD' }, { status: 400 });
  }
  if (startDate > endDate) {
    return NextResponse.json({ error: 'startDate must be <= endDate' }, { status: 400 });
  }

  try {
    await migrate();

    const chunks = dateChunks(startDate, endDate, Math.min(chunkDays, 30));
    console.log(`[ads-backfill] ${chunks.length} chunks from ${startDate}→${endDate}`);

    let totalAsinRows   = 0;
    let totalDailyDates = 0;
    const chunkResults: Array<{ start: string; end: string; rows: number; error?: string }> = [];

    for (const chunk of chunks) {
      console.log(`[ads-backfill] fetching chunk ${chunk.start}→${chunk.end}`);
      try {
        const rows = await fetchAdsReport(chunk.start, chunk.end);
        console.log(`[ads-backfill] chunk ${chunk.start}→${chunk.end}: ${rows.length} rows`);

        if (rows.length > 0) {
          const [asinUpserted, dailyUpserted] = await Promise.all([
            upsertAsinAdSpend(rows),
            upsertDailyMarketingSpend(rows),
          ]);
          totalAsinRows   += asinUpserted;
          totalDailyDates += dailyUpserted;
        }
        chunkResults.push({ start: chunk.start, end: chunk.end, rows: rows.length });
      } catch (chunkErr) {
        const msg = chunkErr instanceof Error ? chunkErr.message : String(chunkErr);
        console.error(`[ads-backfill] chunk ${chunk.start}→${chunk.end} failed:`, msg);
        chunkResults.push({ start: chunk.start, end: chunk.end, rows: 0, error: msg });
        // Continue with remaining chunks
      }
    }

    console.log(`[ads-backfill] done. asinRows=${totalAsinRows} dailyDates=${totalDailyDates}`);

    return NextResponse.json({
      ok: true,
      startDate,
      endDate,
      chunks:          chunks.length,
      totalAsinRows,
      totalDailyDates,
      chunkResults,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ads-backfill]', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
