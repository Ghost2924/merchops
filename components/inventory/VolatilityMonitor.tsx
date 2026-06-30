import { VolatilityEntry } from '@/lib/data/types';

const LOW_SUPPLY_DAYS = 14;

interface VolatilityMonitorProps {
  entries: VolatilityEntry[];
}

function TrendBadge({ trend }: { trend: VolatilityEntry['trend'] }) {
  if (trend === 'up') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-900 text-emerald-300">
        ↑ Up
      </span>
    );
  }
  if (trend === 'down') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-900 text-red-300">
        ↓ Down
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-surface-elevated text-text-secondary">
      → Stable
    </span>
  );
}

function DaysOfSupplyBadge({ days }: { days: number | null }) {
  if (days === null) return <span className="text-gray-300 dark:text-text-muted">—</span>;
  if (days <= 7) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-red-900 text-red-300">
        {days}d ⚠
      </span>
    );
  }
  if (days <= LOW_SUPPLY_DAYS) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-900 text-amber-300">
        {days}d ⚠
      </span>
    );
  }
  return <span className="text-accent-emerald text-xs font-semibold">{days}d</span>;
}

export default function VolatilityMonitor({ entries }: VolatilityMonitorProps) {
  return (
    <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-surface-border">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-text-primary">Sales Velocity Monitor</h3>
        <p className="text-xs text-gray-400 dark:text-text-muted mt-0.5">7-day velocity vs prior 7-day period</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-surface-elevated text-left">
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider">SKU</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider text-right">Velocity (units/day)</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider text-right">Prior Velocity</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider text-center">Trend</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider text-right">Days Supply</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-surface-border">
            {entries.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center">
                  <div className="flex flex-col items-center gap-2 text-gray-400 dark:text-text-muted">
                    <span className="text-2xl">📊</span>
                    <span className="text-sm font-medium">No velocity data</span>
                    <span className="text-xs">Sync orders to populate</span>
                  </div>
                </td>
              </tr>
            ) : (
              entries.map((entry) => (
                <tr key={entry.sku} className="hover:bg-gray-50 dark:hover:bg-surface-hover transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-text-primary font-mono">{entry.sku}</td>
                  <td className="px-4 py-3 text-right text-gray-700 dark:text-text-secondary tabular-nums">
                    {entry.velocityCurrent.toFixed(1)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400 dark:text-text-muted tabular-nums">
                    {entry.velocityPrior.toFixed(1)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <TrendBadge trend={entry.trend} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <DaysOfSupplyBadge days={entry.daysOfSupply} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
