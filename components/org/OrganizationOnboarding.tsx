'use client';

import { useState } from 'react';
import { Building2, ShieldCheck, Users, ArrowRight } from 'lucide-react';
import {
  CreateOrganization,
  OrganizationList,
  useOrganizationList,
} from '@clerk/nextjs';
import { dark } from '@clerk/themes';
import { useTheme } from 'next-themes';
import { DEFAULT_APP_NAME } from '@/lib/config/app';
import { reloadAfterOrgChange } from '@/lib/auth/orgSync';

const STEPS = [
  {
    icon: Building2,
    title: 'Create workspace',
    description: 'One organization per business. Team members share the same data.',
  },
  {
    icon: ShieldCheck,
    title: 'Isolated data',
    description: 'Inventory, orders, and credentials stay scoped to your org.',
  },
  {
    icon: Users,
    title: 'Invite your team',
    description: 'Add collaborators after setup from the org switcher in the nav.',
  },
] as const;

export default function OrganizationOnboarding() {
  const { resolvedTheme } = useTheme();
  const { isLoaded, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const [mode, setMode] = useState<'select' | 'create' | null>(null);

  const isDark = resolvedTheme === 'dark';
  const hasMemberships = (userMemberships?.data?.length ?? 0) > 0;
  const showCreate = isLoaded && (mode === 'create' || (!hasMemberships && mode !== 'select'));

  const clerkAppearance = {
    baseTheme: isDark ? dark : undefined,
    elements: {
      rootBox: 'w-full',
      card: 'shadow-none border-0 bg-transparent p-0',
      headerTitle: 'text-gray-900 dark:text-text-primary text-lg font-semibold',
      headerSubtitle: 'text-gray-500 dark:text-text-secondary text-sm',
      formButtonPrimary:
        'bg-accent-primary hover:bg-accent-glow text-white text-sm font-semibold rounded-xl',
      formFieldInput:
        'rounded-xl border-gray-200 dark:border-surface-border bg-white dark:bg-surface-elevated text-gray-900 dark:text-text-primary',
    },
  };

  return (
    <main className="min-h-[calc(100vh-3.5rem)] relative overflow-hidden bg-gray-50 dark:bg-surface">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(99,102,241,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(99,102,241,0.03)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_75%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-[700px] h-[400px] bg-accent-primary/10 rounded-full blur-[120px]"
      />

      <div className="relative max-w-6xl mx-auto px-6 py-12 lg:py-16">
        <div className="grid lg:grid-cols-[1fr_420px] gap-10 lg:gap-14 items-start">
          {/* Left — value prop */}
          <div className="space-y-8 animate-fadeIn">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-accent-primary mb-3">
                Workspace setup
              </p>
              <h1 className="text-3xl lg:text-4xl font-bold text-gray-900 dark:text-text-primary tracking-tight">
                Select or create your organization
              </h1>
              <p className="mt-3 text-base text-gray-500 dark:text-text-secondary max-w-lg leading-relaxed">
                {DEFAULT_APP_NAME} scopes all inventory, orders, and integrations to an
                organization. Pick an existing workspace or create one to continue.
              </p>
            </div>

            <ul className="space-y-4">
              {STEPS.map(({ icon: Icon, title, description }) => (
                <li
                  key={title}
                  className="flex gap-4 p-4 rounded-2xl border border-gray-200/80 dark:border-surface-border bg-white/60 dark:bg-surface-card/60 backdrop-blur-sm"
                >
                  <div className="shrink-0 w-10 h-10 rounded-xl bg-accent-primary/10 flex items-center justify-center">
                    <Icon size={18} className="text-accent-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-900 dark:text-text-primary">
                      {title}
                    </p>
                    <p className="text-sm text-gray-500 dark:text-text-secondary mt-0.5">
                      {description}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* Right — Clerk org UI */}
          <div className="animate-fadeIn rounded-2xl border border-gray-200 dark:border-surface-border bg-white dark:bg-surface-card shadow-xl shadow-accent-primary/5 p-6 lg:p-8">
            {isLoaded && hasMemberships && (
              <div className="flex gap-2 mb-6 p-1 rounded-xl bg-gray-100 dark:bg-surface-elevated">
                <button
                  type="button"
                  onClick={() => setMode('select')}
                  className={[
                    'flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition-colors',
                    !showCreate
                      ? 'bg-white dark:bg-surface-card text-gray-900 dark:text-text-primary shadow-sm'
                      : 'text-gray-500 dark:text-text-muted hover:text-gray-700 dark:hover:text-text-secondary',
                  ].join(' ')}
                >
                  Select workspace
                </button>
                <button
                  type="button"
                  onClick={() => setMode('create')}
                  className={[
                    'flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition-colors',
                    showCreate
                      ? 'bg-white dark:bg-surface-card text-gray-900 dark:text-text-primary shadow-sm'
                      : 'text-gray-500 dark:text-text-muted hover:text-gray-700 dark:hover:text-text-secondary',
                  ].join(' ')}
                >
                  Create new
                </button>
              </div>
            )}

            {!isLoaded ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <div className="w-8 h-8 rounded-full border-2 border-accent-primary border-t-transparent animate-spin" />
                <p className="text-sm text-gray-400 dark:text-text-muted">Loading workspaces…</p>
              </div>
            ) : showCreate ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-text-secondary">
                  <ArrowRight size={14} className="text-accent-primary" />
                  <span>Name your organization to get started</span>
                </div>
                <CreateOrganization
                  afterCreateOrganizationUrl={() => {
                    reloadAfterOrgChange('/dashboard');
                    return '/dashboard';
                  }}
                  skipInvitationScreen
                  appearance={clerkAppearance}
                />
              </div>
            ) : (
              <OrganizationList
                hidePersonal={true}
                afterSelectOrganizationUrl={() => {
                  reloadAfterOrgChange('/dashboard');
                  return '/dashboard';
                }}
                appearance={clerkAppearance}
              />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
