export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getAmazonOAuthRedirectUri } from '@/lib/amazon/oauth';

export async function GET(req: NextRequest) {
  const applicationId = process.env.AMAZON_VENDOR_APPLICATION_ID;
  if (!applicationId) {
    return NextResponse.json({ error: 'Missing AMAZON_VENDOR_APPLICATION_ID' }, { status: 500 });
  }

  const redirectUri = getAmazonOAuthRedirectUri(req);

  const params = new URLSearchParams({
    application_id: applicationId,
    redirect_uri: redirectUri,
    version: 'beta',
  });

  return NextResponse.redirect(
    `https://vendorcentral.amazon.com/apps/authorize/consent?${params.toString()}`
  );
}
