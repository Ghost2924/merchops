import 'server-only';

import { cache } from 'react';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { orgContext } from '@/lib/db/context';

export const resolveServerOrgId = cache(async (): Promise<string | null> => {
  const store = orgContext.getStore();
  if (store?.orgId) return store.orgId;

  const { orgId, userId } = auth();
  if (orgId) return orgId;
  if (!userId) return null;

  const client = await clerkClient();
  const { data } = await client.users.getOrganizationMembershipList({ userId, limit: 1 });
  return data[0]?.organization.id ?? null;
});
