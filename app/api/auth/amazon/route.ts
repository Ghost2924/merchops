export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

export async function GET() {
  const applicationId = process.env.AMAZON_VENDOR_APPLICATION_ID;
  if (!applicationId) {
    return NextResponse.json({ error: 'Missing AMAZON_VENDOR_APPLICATION_ID' }, { status: 500 });
  }

  const redirectUri = 'https://teapplix-dashboard.vercel.app/api/auth/amazon/callback';

  const params = new URLSearchParams({
    application_id: applicationId,
    redirect_uri: redirectUri,
    version: 'beta',
  });

  return NextResponse.redirect(
    `https://vendorcentral.amazon.com/apps/authorize/consent?${params.toString()}`
  );
}
