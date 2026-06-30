export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getSkuStockHistory } from '@/lib/db/queries';

export async function GET(req: NextRequest) {
  const sku = req.nextUrl.searchParams.get('sku');
  if (!sku || !sku.trim()) {
    return NextResponse.json({ ok: false, error: 'Missing sku param' }, { status: 400 });
  }

  try {
    const history = await getSkuStockHistory(sku.trim());
    return NextResponse.json({ ok: true, sku: sku.trim(), history });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
