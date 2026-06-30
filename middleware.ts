import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  // Inngest invokes this without a Clerk session (local dev server + production cloud).
  // Production auth is enforced by INNGEST_SIGNING_KEY signature verification in serve().
  '/api/inngest',
  '/api/sync',
  '/api/inventory-sync',
  '/api/vendor-sync',
  '/api/ads-sync',
  '/api/marketing-sync',
  '/api/ads-backfill',
  '/api/admin/patch-pack-qty',
]);

export default clerkMiddleware((auth, request) => {
  if (!isPublicRoute(request)) {
    auth().protect();
  }

  const response = NextResponse.next();
  if (!isPublicRoute(request)) {
    response.headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    response.headers.set('Pragma', 'no-cache');
  }
  return response;
});

export const config = {
  matcher: ['/((?!.*\\..*|_next).*)', '/', '/(api|trpc)(.*)', '/__clerk/:path*'],
};
