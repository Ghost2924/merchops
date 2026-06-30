import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
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
});

export const config = {
  matcher: ['/((?!.*\\..*|_next).*)', '/', '/(api|trpc)(.*)', '/__clerk/:path*'],
};
