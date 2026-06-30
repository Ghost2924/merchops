export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getSkuRevenueSearch, getAllSkus } from '@/lib/db/queries';
import { migrate } from '@/lib/db/turso';

/**
 * GET /api/sku-revenue?sku=AM5237&type=month&period=2025-06
 * GET /api/sku-revenue?sku=AM5237&type=year&period=2025
 * GET /api/sku-revenue?list=1  → returns all distinct SKUs
 */
export async function GET(req: NextRequest) {
  await migrate();
  const { searchParams } = req.nextUrl;

  // SKU list mode
  if (searchParams.get('list') === '1') {
    try {
      const skus = await getAllSkus();
      return NextResponse.json({ skus });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  const sku = searchParams.get('sku')?.trim();
  const type = searchParams.get('type') as 'month' | 'year' | null;
  const period = searchParams.get('period')?.trim();

  if (!sku || !type || !period) {
    return NextResponse.json(
      { error: 'Missing required params: sku, type (month|year), period' },
      { status: 400 }
    );
  }

  if (type !== 'month' && type !== 'year') {
    return NextResponse.json({ error: 'type must be "month" or "year"' }, { status: 400 });
  }

  try {
    const result = await getSkuRevenueSearch(sku, type, period);
    if (!result) {
      return NextResponse.json({ result: null, message: 'No data found for this SKU/period' });
    }
    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[/api/sku-revenue]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
