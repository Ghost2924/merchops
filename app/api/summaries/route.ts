export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import {
  getSummariesForYear,
  getAllHistoricalSummaries,
  getNetProfitSummary,
  getDateNDaysAgoInTz,
  getTodayInTz,
} from '@/lib/db/queries';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const yearParam = searchParams.get('year');
  const all = searchParams.get('all');
  const profitSummary = searchParams.get('profitSummary');

  // ?profitSummary=true — return net profit breakdown for last 30 days
  if (profitSummary === 'true') {
    try {
      const days = parseInt(searchParams.get('days') ?? '30', 10);
      const endDate = getTodayInTz();
      const startDate = getDateNDaysAgoInTz(days - 1);
      const data = await getNetProfitSummary(startDate, endDate);
      return NextResponse.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  // ?all=true — return full historical summaries (used by yearly revenue panel)
  if (all === 'true') {
    try {
      const summaries = await getAllHistoricalSummaries();
      return NextResponse.json(summaries);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  if (!yearParam || !/^\d{4}$/.test(yearParam)) {
    return NextResponse.json({ error: 'year param required (YYYY)' }, { status: 400 });
  }

  const year = parseInt(yearParam, 10);

  try {
    const summaries = await getSummariesForYear(year);
    return NextResponse.json(summaries);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
