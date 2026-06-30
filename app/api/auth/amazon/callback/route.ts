export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getDb, migrate } from '@/lib/db/turso';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get('spapi_oauth_code');

  if (!code) {
    return NextResponse.json({ error: 'Missing spapi_oauth_code' }, { status: 400 });
  }

  const clientId = process.env.AMAZON_VENDOR_CLIENT_ID;
  const clientSecret = process.env.AMAZON_VENDOR_CLIENT_SECRET;
  const redirectUri = 'https://teapplix-dashboard.vercel.app/api/auth/amazon/callback';

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: 'Missing AMAZON_VENDOR_CLIENT_ID or AMAZON_VENDOR_CLIENT_SECRET' },
      { status: 500 }
    );
  }

  try {
    // Exchange auth code for tokens
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

    // Persist to DB
    await migrate();
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO integrations (platform, refresh_token, updated_at)
            VALUES ('amazon_vendor', ?, datetime('now'))
            ON CONFLICT(platform) DO UPDATE SET
              refresh_token = excluded.refresh_token,
              updated_at    = datetime('now')`,
      args: [refreshToken],
    });

    return NextResponse.redirect(new URL('/settings?amazon=success', req.nextUrl.origin));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[amazon/callback] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
