import Link from 'next/link';
import LandingCta from '@/components/landing/LandingCta';
import HeroMockup from '@/components/landing/HeroMockup';
import FeatureShowcase from '@/components/landing/FeatureShowcase';
import IntegrationFlow from '@/components/landing/IntegrationFlow';
import TrustSection from '@/components/landing/TrustSection';
import ScrollReveal from '@/components/landing/ScrollReveal';
import { DEFAULT_APP_NAME } from '@/lib/config/app';

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-surface overflow-hidden">
      {/* Hero-only background accents */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[900px] overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(rgba(99,102,241,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(99,102,241,0.04)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(ellipse_at_center,black_15%,transparent_70%)]"
        />
        <div
          aria-hidden
          className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[500px] bg-accent-primary/10 rounded-full blur-[140px]"
        />
      </div>

      {/* Hero */}
      <section className="relative max-w-7xl mx-auto px-6 pt-16 pb-28 lg:pt-24 lg:pb-36">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-20 items-center">
          <ScrollReveal className="space-y-8">
            <div className="space-y-5">
              <h1 className="text-4xl sm:text-5xl lg:text-[3.5rem] font-bold text-text-primary leading-[1.08] tracking-tight">
                Stop losing revenue to inventory mismatches.
              </h1>
              <p className="text-lg text-text-secondary leading-relaxed max-w-xl">
                {DEFAULT_APP_NAME} reconciles your Amazon and Teapplix inventory every night, flags
                discrepancies before they become stockouts, and gives you one dashboard for orders,
                restocking, and vendor performance.
              </p>
            </div>

            <LandingCta variant="hero" />

            <p className="text-xs text-text-muted">
              No credit card required · Encrypted credentials · Per-tenant data isolation
            </p>
          </ScrollReveal>

          <ScrollReveal delay={100} className="lg:pl-2">
            <HeroMockup />
          </ScrollReveal>
        </div>
      </section>

      <FeatureShowcase />
      <IntegrationFlow />
      <TrustSection />

      {/* Final CTA */}
      <section className="relative border-t border-white/[0.06]">
        <div className="max-w-7xl mx-auto px-6 py-20 lg:py-24">
          <ScrollReveal>
            <div className="rounded-2xl border border-white/[0.08] bg-surface-card/40 px-8 py-10 sm:px-12 sm:py-12 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-8">
              <div>
                <p className="text-xl sm:text-2xl font-bold text-text-primary tracking-tight">
                  Ready to centralize your operations?
                </p>
                <p className="text-sm text-text-secondary mt-2">
                  Connect your channels and start with a live dashboard.
                </p>
              </div>
              <LandingCta variant="footer" />
            </div>
          </ScrollReveal>
        </div>
      </section>

      <footer className="border-t border-white/[0.06] py-8">
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between text-xs text-text-muted">
          <span>{DEFAULT_APP_NAME}</span>
          <Link href="/sign-in" className="hover:text-text-secondary transition-colors">
            Sign in
          </Link>
        </div>
      </footer>
    </main>
  );
}
