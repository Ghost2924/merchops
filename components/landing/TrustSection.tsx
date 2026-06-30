import { Building2, Lock, RefreshCw } from 'lucide-react';
import ScrollReveal from './ScrollReveal';

const TRUST_ITEMS = [
  {
    icon: Building2,
    title: 'Per-tenant data isolation',
    description:
      'Every organization gets its own isolated data scope. Your inventory, orders, and credentials never mix with another tenant.',
  },
  {
    icon: Lock,
    title: 'Secure auth via Clerk',
    description:
      'Enterprise-grade authentication with organization switching, role-based access, and encrypted session management.',
  },
  {
    icon: RefreshCw,
    title: 'Nightly automated syncs',
    description:
      'Scheduled inventory reconciliation runs every night. Discrepancies flagged before they become stockouts.',
  },
] as const;

export default function TrustSection() {
  return (
    <section className="relative border-t border-white/[0.06]">
      <div className="max-w-7xl mx-auto px-6 py-28 lg:py-32">
        <ScrollReveal>
          <div className="grid md:grid-cols-3 gap-8 lg:gap-12">
            {TRUST_ITEMS.map(({ icon: Icon, title, description }) => (
              <div key={title} className="space-y-3">
                <div className="w-10 h-10 rounded-lg border border-white/[0.08] bg-surface-elevated/50 flex items-center justify-center">
                  <Icon size={18} className="text-accent-primary" />
                </div>
                <h3 className="text-base font-semibold text-text-primary tracking-tight">{title}</h3>
                <p className="text-sm text-text-secondary leading-relaxed">{description}</p>
              </div>
            ))}
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
