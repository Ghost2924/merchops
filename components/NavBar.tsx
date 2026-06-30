'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BarChart2 } from 'lucide-react';
import ThemeToggle from './ThemeToggle';
import SyncButton from './kpi/SyncButton';
import { OrganizationSwitcher, UserButton, SignInButton, SignUpButton, Show as ClerkShow, SignedIn, SignedOut } from '@clerk/nextjs';
import { dark } from '@clerk/themes';

// Fallback for Show if not exported by @clerk/nextjs
const Show = (ClerkShow as any) || (({ children, when }: { children: React.ReactNode; when: 'signed-in' | 'signed-out' }) => {
  if (when === 'signed-in') {
    return <SignedIn>{children}</SignedIn>;
  }
  return <SignedOut>{children}</SignedOut>;
});
import { useTheme } from 'next-themes';

const BUSINESS_TIMEZONE = process.env.NEXT_PUBLIC_BUSINESS_TIMEZONE ?? 'America/Los_Angeles';

function LiveClock() {
  const [time, setTime] = useState('');
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    function tick() {
      // Derive short timezone label (e.g. "PT", "ET") from the IANA name
      const tzLabel = new Intl.DateTimeFormat('en-US', {
        timeZone: BUSINESS_TIMEZONE,
        timeZoneName: 'short',
      }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? '';

      setTime(
        new Date().toLocaleTimeString('en-US', {
          timeZone: BUSINESS_TIMEZONE,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }) + ' ' + tzLabel
      );
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem('last_sync_at');
    if (!stored) return;
    function updateLabel() {
      const diff = Math.floor((Date.now() - Number(stored)) / 60000);
      setLastSync(diff < 1 ? 'just now' : `${diff}m ago`);
    }
    updateLabel();
    const id = setInterval(updateLabel, 30000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="hidden md:flex flex-col items-end text-xs">
      <span className="font-mono text-text-primary dark:text-text-primary text-gray-700 tabular-nums">
        {time}
      </span>
      {lastSync && (
        <span className="text-text-muted dark:text-text-muted text-gray-400">
          Last synced: {lastSync}
        </span>
      )}
    </div>
  );
}

const NAV_LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/restock', label: 'Restock Planner' },
  { href: '/catalog', label: 'SKU Catalog' },
  { href: '/vendor', label: 'Vendor Central' },
  { href: '/settings/integrations', label: 'Integrations' },
];

export default function NavBar() {
  const pathname = usePathname();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  if (pathname === '/sign-in' || pathname === '/sign-up' || pathname === '/login') return null;

  return (
    <nav className="sticky top-0 z-50 bg-white/90 dark:bg-surface-card/90 backdrop-blur-sm border-b border-gray-200 dark:border-surface-border">
      <div className="max-w-7xl mx-auto px-4 md:px-6 h-14 flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2 shrink-0">
          <BarChart2 size={20} className="text-accent-primary" />
          <span className="font-bold text-gray-900 dark:text-text-primary text-sm tracking-tight">
            BTEXPERT
          </span>
          <span className="hidden sm:block w-px h-4 bg-gray-200 dark:bg-surface-border mx-1" />
          <span className="hidden sm:block text-xs text-gray-400 dark:text-text-muted">
            Operations Dashboard
          </span>
        </div>

        {/* Nav links */}
        <div className="flex items-center gap-1 flex-1 overflow-x-auto">
          {NAV_LINKS.map(({ href, label }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={[
                  'px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors',
                  active
                    ? 'bg-accent-primary text-white'
                    : 'text-gray-500 dark:text-text-secondary hover:text-gray-900 dark:hover:text-text-primary hover:bg-gray-100 dark:hover:bg-surface-hover',
                ].join(' ')}
              >
                {label}
              </Link>
            );
          })}
        </div>

        {/* Right side */}
        <div className="flex items-center gap-3 shrink-0">
          <LiveClock />
          <ThemeToggle />
          <SyncButton />
          <div className="h-4 w-px bg-gray-200 dark:bg-surface-border mx-1" />
          <Show when="signed-out">
            <SignInButton mode="modal">
              <button className="px-3 py-1.5 rounded-full text-xs font-medium bg-accent-primary text-white hover:bg-accent-primary/95 transition-colors">
                Sign In
              </button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button className="px-3 py-1.5 rounded-full text-xs font-medium border border-gray-200 dark:border-surface-border text-gray-700 dark:text-text-primary hover:bg-gray-100 dark:hover:bg-surface-hover transition-colors">
                Sign Up
              </button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <div className="flex items-center gap-3">
              <OrganizationSwitcher
                afterCreateOrganizationUrl="/"
                afterSelectOrganizationUrl="/"
                afterLeaveOrganizationUrl="/"
                appearance={{
                  baseTheme: isDark ? dark : undefined,
                  elements: {
                    organizationSwitcherTrigger: "text-gray-900 dark:text-text-primary hover:bg-gray-100 dark:hover:bg-surface-hover transition-colors rounded-xl px-2 py-1.5 border border-gray-200 dark:border-surface-border",
                  }
                }}
              />
              <UserButton
                afterSignOutUrl="/"
                appearance={{
                  baseTheme: isDark ? dark : undefined,
                }}
              />
            </div>
          </Show>
        </div>
      </div>
    </nav>
  );
}
