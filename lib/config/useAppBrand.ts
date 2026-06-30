'use client';

import { useOrganization } from '@clerk/nextjs';
import { DEFAULT_APP_NAME } from './app';

/**
 * Resolves white-label brand name for client UI.
 * Priority: active Clerk Organization name → NEXT_PUBLIC_APP_NAME → SaaSPlatform.
 */
export function useAppBrand() {
  const { organization, isLoaded } = useOrganization();
  const brandName =
    isLoaded && organization?.name ? organization.name : DEFAULT_APP_NAME;

  return { brandName, isLoaded };
}
