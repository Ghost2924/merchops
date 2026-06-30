import type { NextRequest } from 'next/server';

const PRODUCTION_REDIRECT_URI =
  'https://teapplix-dashboard.vercel.app/api/auth/amazon/callback';

const AMAZON_CALLBACK_PATH = '/api/auth/amazon/callback';

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1' ||
    host.endsWith('.localhost')
  );
}

function resolveRequestHost(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    req.headers.get('host') ||
    req.nextUrl.host
  );
}

function resolveRequestProtocol(req: NextRequest, host: string): string {
  const forwarded = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  return isLoopbackHost(host.split(':')[0]) ? 'http' : 'https';
}

/** OAuth redirect_uri must match Amazon app registration and token exchange. */
export function getAmazonOAuthRedirectUri(req: NextRequest): string {
  const host = resolveRequestHost(req);
  const hostname = host.split(':')[0];

  if (isLoopbackHost(hostname)) {
    const proto = resolveRequestProtocol(req, host);
    return `${proto}://${host}${AMAZON_CALLBACK_PATH}`;
  }

  return PRODUCTION_REDIRECT_URI;
}
