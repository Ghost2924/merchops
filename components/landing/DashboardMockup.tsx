import {
  AlertTriangle,
  BarChart2,
  CheckCircle2,
  Clock,
  DollarSign,
  Package,
  RefreshCw,
  Shield,
} from 'lucide-react';
import { DEFAULT_APP_NAME } from '@/lib/config/app';

const ANOMALIES = [
  {
    sku: 'SKU-A123',
    teapplix: 42,
    amazon: 38,
    delta: -4,
    status: 'Mismatch',
  },
  {
    sku: 'SKU-B456',
    teapplix: 156,
    amazon: 156,
    delta: 0,
    status: 'Matched',
  },
  {
    sku: 'SKU-C789',
    teapplix: 8,
    amazon: 14,
    delta: +6,
    status: 'Mismatch',
  },
  {
    sku: 'SKU-D012',
    teapplix: 0,
    amazon: 3,
    delta: +3,
    status: 'Critical',
  },
] as const;

const SYNC_CHANNELS = [
  { name: 'Amazon SP-API', syncedAgo: '1m ago' },
  { name: 'Teapplix API', syncedAgo: '3m ago' },
] as const;

const NAV_ITEMS = ['Dashboard', 'Restock', 'Catalog', 'Integrations'] as const;

function StatusPill({ status }: { status: (typeof ANOMALIES)[number]['status'] }) {
  const styles = {
    Matched: 'bg-accent-emerald/10 text-accent-emerald border-accent-emerald/25',
    Mismatch: 'bg-accent-amber/10 text-accent-amber border-accent-amber/25',
    Critical: 'bg-accent-red/10 text-accent-red border-accent-red/25',
  } as const;

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-semibold uppercase tracking-wide ${styles[status]}`}
    >
      {status}
    </span>
  );
}

export default function DashboardMockup() {
  return (
    <div className="relative w-full max-w-2xl mx-auto">
      <div className="absolute -inset-px rounded-lg border border-white/[0.06] pointer-events-none" />
      <div className="relative rounded-lg border border-surface-border bg-surface-card overflow-hidden shadow-2xl shadow-black/50">
        {/* Window chrome */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-border bg-surface-elevated">
          <div className="flex gap-1.5 shrink-0">
            <span className="w-2 h-2 rounded-full bg-accent-red/70" />
            <span className="w-2 h-2 rounded-full bg-accent-amber/70" />
            <span className="w-2 h-2 rounded-full bg-accent-emerald/70" />
          </div>
          <div className="flex-1" />
        </div>

        {/* In-app nav */}
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-surface-border bg-surface-card/90">
          <BarChart2 size={11} className="text-accent-primary shrink-0" />
          <span className="text-[10px] font-semibold text-text-primary shrink-0">{DEFAULT_APP_NAME}</span>
          <div className="flex items-center gap-0.5 overflow-hidden ml-1">
            {NAV_ITEMS.map((item, i) => (
              <span
                key={item}
                className={[
                  'px-1.5 py-0.5 rounded text-[9px] font-medium whitespace-nowrap',
                  i === 0
                    ? 'bg-accent-primary text-white'
                    : 'text-text-muted',
                ].join(' ')}
              >
                {item}
              </span>
            ))}
          </div>
        </div>

        {/* Operations body */}
        <div className="p-3.5 space-y-3 bg-surface">
          {/* Header */}
          <h3 className="text-[11px] font-semibold text-text-primary tracking-tight">
            Operations Overview
          </h3>

          {/* KPI row */}
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded border border-surface-border border-l-2 border-l-accent-amber bg-surface-card p-2.5">
              <div className="flex items-center gap-1 text-text-muted mb-1">
                <AlertTriangle size={9} />
                <span className="text-[8px] font-semibold uppercase tracking-wider">
                  Total Discrepancies
                </span>
              </div>
              <p className="text-base font-bold text-text-primary tabular-nums leading-none">7</p>
              <p className="text-[8px] text-accent-amber mt-1 font-medium">24h window</p>
            </div>

            <div className="rounded border border-surface-border border-l-2 border-l-accent-primary bg-surface-card p-2.5">
              <div className="flex items-center gap-1 text-text-muted mb-1">
                <CheckCircle2 size={9} />
                <span className="text-[8px] font-semibold uppercase tracking-wider">
                  Auto-Resolved
                </span>
              </div>
              <p className="text-base font-bold text-text-primary tabular-nums leading-none">14</p>
              <p className="text-[8px] text-text-muted mt-1">This week</p>
            </div>

            <div className="rounded border border-surface-border border-l-2 border-l-accent-emerald bg-surface-card p-2.5">
              <div className="flex items-center gap-1 text-text-muted mb-1">
                <DollarSign size={9} />
                <span className="text-[8px] font-semibold uppercase tracking-wider">
                  Revenue Protected
                </span>
              </div>
              <p className="text-base font-bold text-text-primary tabular-nums leading-none">$12.4k</p>
              <p className="text-[8px] text-accent-emerald mt-1 font-medium">Stockouts prevented</p>
            </div>
          </div>

          {/* Inventory anomaly table */}
          <div className="rounded border border-surface-border bg-surface-card overflow-hidden">
            <div className="flex items-center justify-between px-2.5 py-2 border-b border-surface-border bg-surface-elevated/50">
              <div className="flex items-center gap-1.5">
                <Package size={10} className="text-accent-primary" />
                <span className="text-[9px] font-semibold text-text-primary uppercase tracking-wider">
                  Inventory Anomaly Detection
                </span>
              </div>
              <div className="flex items-center gap-1 text-[8px] text-text-muted">
                <Shield size={8} className="text-accent-emerald/70" />
                <span>Tenant isolated</span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-[9px]">
                <thead>
                  <tr className="bg-surface-elevated/40 text-left border-b border-surface-border">
                    <th className="px-2.5 py-1.5 font-semibold text-text-muted uppercase tracking-wider">
                      SKU
                    </th>
                    <th className="px-2 py-1.5 font-semibold text-text-muted uppercase tracking-wider text-right">
                      Teapplix
                    </th>
                    <th className="px-2 py-1.5 font-semibold text-text-muted uppercase tracking-wider text-right">
                      Amazon SP-API
                    </th>
                    <th className="px-2 py-1.5 font-semibold text-text-muted uppercase tracking-wider text-right">
                      Δ
                    </th>
                    <th className="px-2.5 py-1.5 font-semibold text-text-muted uppercase tracking-wider text-right">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ANOMALIES.map((row) => (
                    <tr
                      key={row.sku}
                      className="border-b border-surface-border/60 last:border-0 hover:bg-surface-hover/40 transition-colors"
                    >
                      <td className="px-2.5 py-1.5 font-mono font-medium text-text-primary">
                        {row.sku}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-text-secondary">
                        {row.teapplix}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-text-secondary">
                        {row.amazon}
                      </td>
                      <td
                        className={[
                          'px-2 py-1.5 text-right tabular-nums font-semibold',
                          row.delta === 0
                            ? 'text-text-muted'
                            : row.delta < 0
                              ? 'text-accent-amber'
                              : 'text-accent-red',
                        ].join(' ')}
                      >
                        {row.delta > 0 ? `+${row.delta}` : row.delta}
                      </td>
                      <td className="px-2.5 py-1.5 text-right">
                        <StatusPill status={row.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Channel sync detail */}
          <div className="rounded border border-surface-border bg-surface-card p-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <RefreshCw size={9} className="text-accent-primary" />
                <span className="text-[9px] font-semibold text-text-primary uppercase tracking-wider">
                  Channel Sync
                </span>
              </div>
              <div className="flex items-center gap-1 text-[8px] text-text-muted">
                <Shield size={8} className="text-accent-emerald/70" />
                <span>Tenant isolated</span>
              </div>
            </div>

            <div className="space-y-1.5">
              {SYNC_CHANNELS.map((channel) => (
                <div
                  key={channel.name}
                  className="flex items-center justify-between gap-2 rounded border border-surface-border/80 bg-surface-elevated/30 px-2 py-1.5"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-emerald shrink-0 shadow-[0_0_4px_rgba(16,185,129,0.4)]" />
                    <span className="text-[9px] text-text-secondary truncate">{channel.name}</span>
                    <span className="text-[9px] font-medium text-accent-emerald">Active</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 text-[8px] text-text-muted">
                    <Clock size={8} />
                    <span>Synced {channel.syncedAgo}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
