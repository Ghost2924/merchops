import { AsyncLocalStorage } from 'node:async_hooks';

export interface OrgContextStore {
  orgId: string | null;
  bypass: boolean;
}

export const orgContext = new AsyncLocalStorage<OrgContextStore>();

export function runWithOrg<T>(orgId: string | null, bypass: boolean, fn: () => T | Promise<T>): T | Promise<T> {
  return orgContext.run({ orgId, bypass }, fn);
}

export function getOrgContext(): OrgContextStore {
  const store = orgContext.getStore();
  if (store) {
    return store;
  }

  // Fallback to Clerk request-level authentication
  try {
    const { auth } = require('@clerk/nextjs/server');
    const { orgId } = auth();
    return { orgId: orgId ?? null, bypass: false };
  } catch {
    // Bypassed if we're running outside Next.js request context (migrations, seeds, tests)
    return { orgId: null, bypass: true };
  }
}
