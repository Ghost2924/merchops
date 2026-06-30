'use client';

import {
  ArrowRight,
  CalendarClock,
  LayoutDashboard,
  Link2,
  Plug,
  Shield,
  Table2,
} from 'lucide-react';
import ScrollReveal from './ScrollReveal';

const STEPS = [
  {
    step: 1,
    title: 'Connect Channels',
    summary: 'Link Amazon SP-API and Teapplix in under two minutes.',
    icon: Plug,
  },
  {
    step: 2,
    title: 'Link Inventory',
    summary: 'Auto-match product catalogs across both marketplaces.',
    icon: Table2,
  },
  {
    step: 3,
    title: 'Automate Audits',
    summary: 'Nightly syncs catch stock mismatches before lost sales.',
    icon: CalendarClock,
  },
] as const;

function ConnectVisual() {
  return (
    <div className="flex items-center justify-center gap-4 py-2">
      <div className="flex flex-col items-center gap-1.5">
        <div className="w-12 h-12 rounded-xl border border-[#FF9900]/40 bg-[#FF9900]/10 flex items-center justify-center">
          <span className="text-[#FF9900] font-bold text-sm">A</span>
        </div>
        <span className="text-[10px] text-text-muted">Amazon</span>
      </div>
      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center gap-1">
          <div className="w-8 h-px bg-gradient-to-r from-[#FF9900]/60 to-accent-primary/60" />
          <div className="w-6 h-6 rounded-full border border-accent-emerald/30 bg-accent-emerald/10 flex items-center justify-center">
            <Link2 size={11} className="text-accent-emerald" />
          </div>
          <div className="w-8 h-px bg-gradient-to-r from-accent-primary/60 to-accent-primary/40" />
        </div>
        <div className="flex items-center gap-1 px-2 py-0.5 rounded-full border border-accent-emerald/20 bg-accent-emerald/5">
          <Shield size={8} className="text-accent-emerald" />
          <span className="text-[9px] text-accent-emerald font-medium">Encrypted</span>
        </div>
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <div className="w-12 h-12 rounded-xl border border-accent-primary/40 bg-accent-primary/10 flex items-center justify-center">
          <span className="text-accent-primary font-bold text-sm">T</span>
        </div>
        <span className="text-[10px] text-text-muted">Teapplix</span>
      </div>
    </div>
  );
}

function AuditPipelineVisual() {
  return (
    <div className="flex items-center justify-center gap-6 py-4">
      <div className="flex flex-col items-center gap-2">
        <div className="w-14 h-14 rounded-xl border border-white/[0.08] bg-surface-elevated flex items-center justify-center">
          <CalendarClock size={24} className="text-accent-violet" strokeWidth={1.5} />
        </div>
        <div className="text-center">
          <p className="text-xs font-semibold text-text-primary">Nightly Audit</p>
          <p className="text-[10px] text-text-muted">Runs while you sleep</p>
        </div>
      </div>

      <div className="flex flex-col items-center gap-1">
        <ArrowRight size={16} className="text-accent-primary" />
        <span className="text-[9px] text-accent-amber font-medium uppercase tracking-wider">
          flags
        </span>
      </div>

      <div className="flex flex-col items-center gap-2">
        <div className="w-14 h-14 rounded-xl border border-accent-primary/30 bg-accent-primary/10 flex items-center justify-center">
          <LayoutDashboard size={24} className="text-accent-primary" strokeWidth={1.5} />
        </div>
        <div className="text-center">
          <p className="text-xs font-semibold text-text-primary">Mismatch Alerts</p>
          <p className="text-[10px] text-accent-emerald">Before lost sales</p>
        </div>
      </div>
    </div>
  );
}

export default function IntegrationFlow() {
  return (
    <section id="how-it-works" className="relative border-t border-white/[0.06] scroll-mt-20">
      <div className="max-w-7xl mx-auto px-6 py-28 lg:py-40">
        <ScrollReveal className="text-center max-w-2xl mx-auto mb-16 lg:mb-20">
          <p className="text-xs font-semibold uppercase tracking-widest text-accent-primary mb-3">
            How it works
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold text-text-primary tracking-tight">
            Up and running in minutes
          </h2>
          <p className="mt-4 text-text-secondary leading-relaxed">
            Connect your channels, match your inventory, and let nightly audits protect your revenue.
          </p>
        </ScrollReveal>

        <ScrollReveal delay={100}>
          <div className="relative">
            <div className="hidden lg:block absolute top-[2.75rem] left-[16.67%] right-[16.67%] h-px bg-gradient-to-r from-transparent via-white/[0.08] to-transparent" />

            <div className="grid lg:grid-cols-3 gap-6 lg:gap-8">
              {STEPS.map((step, index) => {
                const Icon = step.icon;
                return (
                  <div key={step.title} className="relative">
                    {index < STEPS.length - 1 && (
                      <div
                        aria-hidden
                        className="hidden lg:flex absolute top-[2.75rem] -right-4 z-10 items-center"
                      >
                        <ArrowRight size={16} className="text-white/20" />
                      </div>
                    )}
                    <div className="rounded-xl border border-white/[0.08] bg-surface-card/60 p-6 h-full">
                      <div className="flex items-center gap-3 mb-4">
                        <div className="w-10 h-10 rounded-lg bg-accent-primary text-white flex items-center justify-center text-sm font-bold shrink-0">
                          {step.step}
                        </div>
                        <div className="w-9 h-9 rounded-lg border border-white/[0.08] bg-surface-elevated flex items-center justify-center">
                          <Icon size={16} className="text-accent-primary" />
                        </div>
                      </div>
                      <h3 className="text-base font-semibold text-text-primary tracking-tight">
                        {step.title}
                      </h3>
                      <p className="text-sm text-text-secondary mt-2 leading-relaxed">
                        {step.summary}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </ScrollReveal>

        <ScrollReveal delay={200} className="mt-10 lg:mt-12">
          <div className="grid lg:grid-cols-2 gap-6">
            <div className="rounded-xl border border-white/[0.08] bg-surface-card/40 p-6 lg:p-8">
              <p className="text-xs font-semibold uppercase tracking-widest text-text-muted mb-4">
                Secure connection
              </p>
              <ConnectVisual />
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-surface-card/40 p-6 lg:p-8">
              <p className="text-xs font-semibold uppercase tracking-widest text-text-muted mb-4">
                Automated protection
              </p>
              <AuditPipelineVisual />
            </div>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
