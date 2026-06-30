export const DEFAULT_APP_NAME =
  process.env.NEXT_PUBLIC_APP_NAME?.trim() || 'SaaSPlatform';

export const APP_TAGLINE = 'Operations Dashboard';

export function getAppTitle(pageTitle?: string): string {
  const base = `${DEFAULT_APP_NAME} ${APP_TAGLINE}`;
  return pageTitle ? `${pageTitle} | ${base}` : base;
}
