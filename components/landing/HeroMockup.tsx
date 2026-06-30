import {
  AlertTriangle,
  CheckCircle2,
  DollarSign,
  ShoppingCart,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import MockupFrame from './MockupFrame';

const CHART_BARS = [42, 58, 51, 67, 73, 61, 78, 85, 72, 88, 91, 84, 79, 95] as const;

export default function HeroMockup() {
  return (
    <MockupFrame title="Operations Overview">
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-white/[0.06] border-l-2 border-l-accent-amber bg-surface-elevated/50 p-3.5">
            <div className="flex items-center gap-1.5 text-text-muted mb-2">
              <AlertTriangle size={12} />
              <span className="text-[10px] font-semibold uppercase tracking-wider">
                Total Discrepancies
              </span>
            </div>
            <p className="text-2xl sm:text-3xl font-bold text-text-primary tabular-nums leading-none">
              7
            </p>
            <p className="text-[10px] text-accent-amber mt-1.5 font-medium">Last 24 hours</p>
          </div>

          <div className="rounded-lg border border-white/[0.06] border-l-2 border-l-accent-primary bg-surface-elevated/50 p-3.5">
            <div className="flex items-center gap-1.5 text-text-muted mb-2">
              <CheckCircle2 size={12} />
              <span className="text-[10px] font-semibold uppercase tracking-wider">
                Auto-Resolved
              </span>
            </div>
            <p className="text-2xl sm:text-3xl font-bold text-text-primary tabular-nums leading-none">
              14
            </p>
            <p className="text-[10px] text-text-muted mt-1.5">This week</p>
          </div>

          <div className="rounded-lg border border-white/[0.06] border-l-2 border-l-accent-emerald bg-surface-elevated/50 p-3.5">
            <div className="flex items-center gap-1.5 text-text-muted mb-2">
              <DollarSign size={12} />
              <span className="text-[10px] font-semibold uppercase tracking-wider">
                Revenue Protected
              </span>
            </div>
            <p className="text-2xl sm:text-3xl font-bold text-text-primary tabular-nums leading-none">
              $12.4k
            </p>
            <p className="text-[10px] text-accent-emerald mt-1.5 font-medium">
              Stockouts prevented
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {[
            { label: 'Orders Today', value: '142', icon: ShoppingCart, accent: 'text-accent-primary' },
            { label: 'Revenue Today', value: '$8,420', icon: DollarSign, accent: 'text-accent-emerald' },
            { label: 'Net Profit', value: '$2,180', icon: Wallet, accent: 'text-accent-violet' },
            { label: 'AOV', value: '$59.30', icon: TrendingUp, accent: 'text-accent-primary' },
          ].map(({ label, value, icon: Icon, accent }) => (
            <div
              key={label}
              className="rounded-lg border border-white/[0.06] bg-surface-elevated/30 px-3 py-2.5"
            >
              <div className="flex items-center gap-1 text-text-muted mb-1">
                <Icon size={10} className={accent} />
                <span className="text-[9px] font-medium uppercase tracking-wide">{label}</span>
              </div>
              <p className="text-sm font-bold text-text-primary tabular-nums">{value}</p>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-white/[0.06] bg-surface-elevated/30 p-3.5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-semibold text-text-primary">Daily Revenue Trend</span>
            <span className="text-[10px] text-accent-emerald font-medium">+12.4% MTD</span>
          </div>
          <div className="flex items-end gap-1 h-16">
            {CHART_BARS.map((h, i) => (
              <div
                key={i}
                className="flex-1 rounded-sm bg-accent-primary/20 hover:bg-accent-primary/40 transition-colors"
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
        </div>
      </div>
    </MockupFrame>
  );
}
