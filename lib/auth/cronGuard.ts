/**
 * lib/auth/cronGuard.ts
 *
 * Shared Bearer-token auth check for cron/internal API endpoints.
 * Returns a 401 NextResponse when auth fails, or null when auth passes.
 *
 * Usage:
 *   const deny = cronGuard(req);
 *   if (deny) return deny;
 */

import { NextRequest, NextResponse } from 'next/server';

export function cronGuard(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return null; // no secret configured — open in dev

  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  if (token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
