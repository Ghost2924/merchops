export const dynamic = 'force-dynamic';

import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import { getAmazonOAuthRedirectUri } from '@/lib/amazon/oauth';
import { runWithOrg } from '@/lib/db/context';
import { saveOrganizationCredentials } from '@/lib/db/queries';
import { migrate } from '@/lib/db/turso';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get('spapi_oauth_code');

  if (!code) {
    return NextResponse.json({ error: 'Missing spapi_oauth_code' }, { status: 400 });
  }

  const clientId = process.env.AMAZON_VENDOR_CLIENT_ID;
  const clientSecret = process.env.AMAZON_VENDOR_CLIENT_SECRET;
  const redirectUri = getAmazonOAuthRedirectUri(req);

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: 'Missing AMAZON_VENDOR_CLIENT_ID or AMAZON_VENDOR_CLIENT_SECRET' },
      { status: 500 }
    );
  }

  const organizationId = searchParams.get('state') ?? auth().orgId;
  if (!organizationId) {
    return NextResponse.json({ error: 'Missing organization context' }, { status: 400 });
  }

  try {
    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error('[amazon/callback] token exchange failed:', body);
      return NextResponse.json({ error: 'Token exchange failed', detail: body }, { status: 502 });
    }

    const tokenData = (await tokenRes.json()) as { refresh_token?: string };
    const refreshToken = tokenData.refresh_token;

    if (!refreshToken) {
      return NextResponse.json({ error: 'No refresh_token in response' }, { status: 502 });
    }

    await migrate();
    await runWithOrg(organizationId, false, async () => {
      await saveOrganizationCredentials(
        { amazon_refresh_token: refreshToken },
        organizationId
      );
    });

    return NextResponse.redirect(new URL('/settings/integrations?amazon=success', req.nextUrl.origin));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[amazon/callback] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
