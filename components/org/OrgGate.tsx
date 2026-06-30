'use client';

import { useOrganization } from '@clerk/nextjs';
import OrganizationOnboarding from '@/components/org/OrganizationOnboarding';

export default function OrgGate({ children }: { children: React.ReactNode }) {
  const { organization, isLoaded } = useOrganization();

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="w-8 h-8 rounded-full border-2 border-accent-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!organization) {
    return <OrganizationOnboarding />;
  }

  return <>{children}</>;
}
