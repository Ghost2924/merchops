'use client';

import Link from 'next/link';
import { SignedIn, SignedOut, SignInButton } from '@clerk/nextjs';
import { ArrowRight } from 'lucide-react';

interface LandingCtaProps {
  variant?: 'hero' | 'footer' | 'primary';
}

export default function LandingCta({ variant = 'primary' }: LandingCtaProps) {
  const primaryBtn =
    'inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg bg-accent-primary text-white text-sm font-semibold hover:bg-accent-glow transition-colors';

  const secondaryBtn =
    'inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg border border-white/[0.12] text-text-primary text-sm font-semibold hover:bg-white/[0.04] transition-colors';

  if (variant === 'hero') {
    return (
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <SignedIn>
          <Link href="/dashboard" className={primaryBtn}>
            Go to Dashboard
            <ArrowRight size={16} />
          </Link>
        </SignedIn>
        <SignedOut>
          <Link href="/sign-in" className={primaryBtn}>
            Go to Dashboard
            <ArrowRight size={16} />
          </Link>
        </SignedOut>
        <a href="#features" className={secondaryBtn}>
          See how it works
        </a>
      </div>
    );
  }

  const singlePrimary = (
    <>
      <SignedIn>
        <Link href="/dashboard" className={primaryBtn}>
          Go to Dashboard
          <ArrowRight size={16} />
        </Link>
      </SignedIn>
      <SignedOut>
        <Link href="/sign-in" className={primaryBtn}>
          Go to Dashboard
          <ArrowRight size={16} />
        </Link>
      </SignedOut>
    </>
  );

  if (variant === 'footer') {
    return <div className="shrink-0">{singlePrimary}</div>;
  }

  return singlePrimary;
}

export function LandingSignInButton() {
  return (
    <SignedOut>
      <SignInButton mode="modal">
        <button className="px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary transition-colors">
          Sign in
        </button>
      </SignInButton>
    </SignedOut>
  );
}

export function LandingDashboardButton() {
  const btnClass =
    'px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-primary text-white hover:bg-accent-glow transition-colors';

  return (
    <>
      <SignedIn>
        <Link href="/dashboard" className={btnClass}>
          Go to Dashboard
        </Link>
      </SignedIn>
      <SignedOut>
        <Link href="/sign-in" className={btnClass}>
          Go to Dashboard
        </Link>
      </SignedOut>
    </>
  );
}
