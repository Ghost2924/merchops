import { VolatilityEntry } from '@/lib/data/types';

interface ReorderAlertsProps {
  entries: VolatilityEntry[];
  criticalDays?: number;
  warningDays?: number;
}

function DaysBar({ days }: { days: number }) {
  const pct = Math.min((days / 30) * 100, 100);
  const color =
    days <= 7
      ? 'bg-accent-red'
      : days <= 14
      ? 'bg-accent-amber'
      : 'bg-accent-emerald';
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 bg-gray-100 dark:bg-surface-elevated rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span
        className={`text-xs font-bold tabular-nums ${
          days <= 7
            ? 'text-accent-red'
            : days <= 14
            ? 'text-accent-amber'
            : 'text-accent-emerald'
        }`}
      >
        {days}d
      </span>
    </div>
  );
}

function stockoutDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function ReorderAlerts({
  entries,
  criticalDays = 7,
  warningDays = 14,
}: ReorderAlertsProps) {
  const alerts = entries
    .filter((e) => e.daysOfSupply !== null && e.daysOfSupply <= warningDays)
    .sort((a, b) => (a.daysOfSupply ?? 999) - (b.daysOfSupply ?? 999));

  if (alerts.length === 0) return null;

  const critical = alerts.filter((e) => (e.daysOfSupply ?? 999) <= criticalDays);
  const warning = alerts.filter(
    (e) => (e.daysOfSupply ?? 999) > criticalDays && (e.daysOfSupply ?? 999) <= warningDays
  );

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        {critical.length > 0 && (
          <span className="w-2 h-2 rounded-full bg-accent-red animate-pulse" />
        )}
        <h2 className="text-xs font-semibold text-gray-400 dark:text-text-muted uppercase tracking-widest">
          Reorder Alerts
        </h2>
      </div>
      <div className="bg-white dark:bg-surface-card rounded-2xl border border-red-100 dark:border-surface-border overflow-hidden">
        <div className="px-6 py-4 border-b border-red-100 dark:border-surface-border flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="text-sm font-semibold text-red-700 dark:text-red-400">
              🚨 {alerts.length} SKU{alerts.length !== 1 ? 's' : ''} need restocking
            </h3>
            <p className="text-xs text-gray-400 dark:text-text-muted mt-0.5">
              Based on current velocity vs available stock
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs flex-wrap">
            {critical.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-red-900 text-red-300 font-semibold">
                🔴 {critical.length} critical (≤{criticalDays}d)
              </span>
            )}
            {warning.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-900 text-amber-300 font-semibold">
                🟡 {warning.length} warning (≤{warningDays}d)
              </span>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-surface-elevated text-left">
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider">SKU</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider">Days of Supply</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider text-right">Est. Stockout</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider text-right">Velocity</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider text-center">Trend</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider text-right">Urgency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-surface-border">
              {alerts.map((entry) => {
                const isCritical = (entry.daysOfSupply ?? 999) <= criticalDays;
                return (
                  <tr
                    key={entry.sku}
                    className={[
                      'transition-colors hover:bg-gray-50 dark:hover:bg-surface-hover',
                      isCritical
                        ? 'border-l-4 border-l-accent-red bg-red-50/40 dark:bg-red-950/30'
                        : 'border-l-4 border-l-accent-amber bg-yellow-50/20 dark:bg-amber-950/20',
                    ].join(' ')}
                  >
                    <td className="px-4 py-3 font-semibold text-gray-900 dark:text-text-primary font-mono">
                      {entry.sku}
                    </td>
                    <td className="px-4 py-3">
                      <DaysBar days={entry.daysOfSupply ?? 0} />
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-gray-500 dark:text-text-secondary tabular-nums">
                      {entry.daysOfSupply !== null ? stockoutDate(entry.daysOfSupply) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700 dark:text-text-secondary tabular-nums">
                      {entry.velocityCurrent.toFixed(1)}/d
                    </td>
                    <td className="px-4 py-3 text-center">
                      {entry.trend === 'up' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-900 text-emerald-300">↑ Up</span>
                      )}
                      {entry.trend === 'down' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-900 text-red-300">↓ Down</span>
                      )}
                      {entry.trend === 'stable' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-surface-elevated text-text-secondary">→ Stable</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={`text-xs font-bold uppercase tracking-wide ${isCritical ? 'text-accent-red' : 'text-accent-amber'}`}>
                        {isCritical ? 'REORDER NOW' : 'REORDER SOON'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
