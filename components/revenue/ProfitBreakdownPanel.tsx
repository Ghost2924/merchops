'use client';

import { useState, useEffect } from 'react';
import { formatUSD } from '@/lib/formatters';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface NetProfitRow {
  date: string;
  revenue: number;
  cogs: number;
  marketing_spend: number;
  net_profit: number;
}

const PERIODS = [
  { label: '7d', days: 7 },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 },
] as const;

function fmtDate(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
  });
}

function MarginBadge({ margin }: { margin: number }) {
  const color =
    margin >= 20
      ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40'
      : margin >= 0
      ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40'
      : 'text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-950/40';
  const Icon = margin > 0 ? TrendingUp : margin < 0 ? TrendingDown : Minus;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${color}`}>
      <Icon size={9} />
      {margin.toFixed(1)}%
    </span>
  );
}

export default function ProfitBreakdownPanel() {
  const [period, setPeriod] = useState<7 | 14 | 30>(30);
  const [rows, setRows] = useState<NetProfitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/summaries?profitSummary=true&days=${period}`)
      .then((r) => r.json())
      .then((data: NetProfitRow[] | { error: string }) => {
        if ('error' in data) {
          setError((data as { error: string }).error);
        } else {
          setRows((data as NetProfitRow[]).sort((a, b) => b.date.localeCompare(a.date)));
        }
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [period]);

  const totals = rows.reduce(
    (acc, r) => ({
      revenue: acc.revenue + r.revenue,
      cogs: acc.cogs + r.cogs,
      marketing_spend: acc.marketing_spend + r.marketing_spend,
      net_profit: acc.net_profit + r.net_profit,
    }),
    { revenue: 0, cogs: 0, marketing_spend: 0, net_profit: 0 }
  );

  const overallMargin =
    totals.revenue > 0 ? (totals.net_profit / totals.revenue) * 100 : 0;

  // For the inline bar: max per-row gross revenue used as scale
  const maxRevenue = Math.max(...rows.map((r) => r.revenue), 1);

  return (
    <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 dark:border-surface-border flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-text-primary">
            Profit & Cost Breakdown
          </h3>
          <p className="text-xs text-gray-400 dark:text-text-muted">
            Revenue − COGS − Ads &amp; Coupons = Net Profit
          </p>
        </div>

        {/* Period toggle */}
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-surface-elevated rounded-lg p-0.5">
          {PERIODS.map(({ label, days }) => (
            <button
              key={days}
              onClick={() => setPeriod(days as 7 | 14 | 30)}
              className={[
                'text-xs font-semibold px-3 py-1 rounded-md transition-all',
                period === days
                  ? 'bg-white dark:bg-surface-card text-gray-900 dark:text-text-primary shadow-sm'
                  : 'text-gray-500 dark:text-text-muted hover:text-gray-700 dark:hover:text-text-secondary',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary pills */}
      {!loading && !error && rows.length > 0 && (
        <div className="px-4 py-3 border-b border-gray-100 dark:border-surface-border grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: 'Revenue', value: formatUSD(totals.revenue), color: 'text-gray-900 dark:text-text-primary' },
            { label: 'COGS', value: formatUSD(totals.cogs), color: 'text-blue-600 dark:text-blue-400' },
            { label: 'Ads & Coupons', value: formatUSD(totals.marketing_spend), color: 'text-violet-600 dark:text-violet-400' },
            {
              label: 'Net Profit',
              value: formatUSD(totals.net_profit),
              color:
                totals.net_profit >= 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-red-500 dark:text-red-400',
            },
          ].map(({ label, value, color }) => (
            <div
              key={label}
              className="bg-gray-50 dark:bg-surface-elevated rounded-xl px-3 py-2"
            >
              <p className="text-[10px] text-gray-400 dark:text-text-muted uppercase tracking-wide leading-none">
                {label}
              </p>
              <p className={`text-sm font-bold mt-0.5 tabular-nums ${color}`}>{value}</p>
              {label === 'Net Profit' && (
                <p className="text-[10px] text-gray-400 dark:text-text-muted mt-0.5">
                  {overallMargin.toFixed(1)}% margin
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-xs text-gray-400 dark:text-text-muted">
            Loading…
          </div>
        ) : error ? (
          <div className="flex items-center justify-center py-12 text-xs text-red-400">
            Failed to load: {error}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-xs text-gray-400 dark:text-text-muted">
            No data for this period
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 dark:border-surface-border">
                {['Date', 'Revenue', 'COGS', 'Ads & Coupons', 'Net Profit', 'Margin', 'Cost Split'].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-2 text-left font-semibold text-gray-400 dark:text-text-muted uppercase tracking-wide text-[10px] whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-surface-border">
              {rows.map((row) => {
                const margin =
                  row.revenue > 0 ? (row.net_profit / row.revenue) * 100 : 0;
                // Stacked bar segments as % of revenue
                const cogsW = row.revenue > 0 ? (row.cogs / row.revenue) * 100 : 0;
                const mktW = row.revenue > 0 ? (row.marketing_spend / row.revenue) * 100 : 0;
                const profitW = Math.max(margin, 0);
                const today = new Date().toLocaleDateString('en-CA');

                return (
                  <tr
                    key={row.date}
                    className={[
                      'transition-colors',
                      row.date === today
                        ? 'bg-accent-primary/5 dark:bg-accent-primary/10'
                        : 'hover:bg-gray-50 dark:hover:bg-surface-hover',
                    ].join(' ')}
                  >
                    <td className="px-4 py-2.5 font-medium text-gray-700 dark:text-text-primary whitespace-nowrap">
                      {fmtDate(row.date)}
                      {row.date === today && (
                        <span className="ml-1 text-[9px] font-bold text-accent-primary bg-accent-primary/10 px-1 py-0.5 rounded-full">
                          today
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-gray-900 dark:text-text-primary font-semibold">
                      {formatUSD(row.revenue)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-blue-600 dark:text-blue-400">
                      {row.cogs > 0 ? formatUSD(row.cogs) : <span className="text-gray-300 dark:text-text-muted">—</span>}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-violet-600 dark:text-violet-400">
                      {row.marketing_spend > 0
                        ? formatUSD(row.marketing_spend)
                        : <span className="text-gray-300 dark:text-text-muted">—</span>}
                    </td>
                    <td
                      className={[
                        'px-4 py-2.5 tabular-nums font-bold',
                        row.net_profit >= 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-red-500 dark:text-red-400',
                      ].join(' ')}
                    >
                      {formatUSD(row.net_profit)}
                    </td>
                    <td className="px-4 py-2.5">
                      <MarginBadge margin={margin} />
                    </td>
                    {/* Stacked cost bar */}
                    <td className="px-4 py-2.5 min-w-[120px]">
                      {row.revenue > 0 ? (
                        <div className="flex h-2 w-full rounded-full overflow-hidden bg-gray-100 dark:bg-surface-elevated">
                          <div
                            title={`COGS ${cogsW.toFixed(1)}%`}
                            className="h-full bg-blue-400 dark:bg-blue-500 transition-all"
                            style={{ width: `${Math.min(cogsW, 100)}%` }}
                          />
                          <div
                            title={`Ads & Coupons ${mktW.toFixed(1)}%`}
                            className="h-full bg-violet-400 dark:bg-violet-500 transition-all"
                            style={{ width: `${Math.min(mktW, 100 - cogsW)}%` }}
                          />
                          <div
                            title={`Net Profit ${profitW.toFixed(1)}%`}
                            className="h-full bg-emerald-400 dark:bg-emerald-500 transition-all"
                            style={{ width: `${Math.min(profitW, 100 - cogsW - mktW)}%` }}
                          />
                        </div>
                      ) : (
                        <div className="h-2 w-full rounded-full bg-gray-100 dark:bg-surface-elevated" />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {/* Totals row */}
            <tfoot>
              <tr className="border-t-2 border-gray-200 dark:border-surface-border bg-gray-50 dark:bg-surface-elevated">
                <td className="px-4 py-2.5 font-bold text-gray-600 dark:text-text-secondary text-[10px] uppercase tracking-wide">
                  Total ({rows.length}d)
                </td>
                <td className="px-4 py-2.5 tabular-nums font-bold text-gray-900 dark:text-text-primary">
                  {formatUSD(totals.revenue)}
                </td>
                <td className="px-4 py-2.5 tabular-nums font-bold text-blue-600 dark:text-blue-400">
                  {formatUSD(totals.cogs)}
                </td>
                <td className="px-4 py-2.5 tabular-nums font-bold text-violet-600 dark:text-violet-400">
                  {formatUSD(totals.marketing_spend)}
                </td>
                <td
                  className={[
                    'px-4 py-2.5 tabular-nums font-bold',
                    totals.net_profit >= 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-red-500 dark:text-red-400',
                  ].join(' ')}
                >
                  {formatUSD(totals.net_profit)}
                </td>
                <td className="px-4 py-2.5">
                  <MarginBadge margin={overallMargin} />
                </td>
                <td className="px-4 py-2.5" />
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* Legend */}
      <div className="px-4 py-2.5 border-t border-gray-100 dark:border-surface-border flex items-center gap-4 flex-wrap">
        {[
          { color: 'bg-blue-400 dark:bg-blue-500', label: 'COGS' },
          { color: 'bg-violet-400 dark:bg-violet-500', label: 'Ads & Coupons' },
          { color: 'bg-emerald-400 dark:bg-emerald-500', label: 'Net Profit' },
          { color: 'bg-gray-100 dark:bg-surface-elevated', label: 'Loss / no data' },
        ].map(({ color, label }) => (
          <div key={label} className="flex items-center gap-1.5 text-[10px] text-gray-500 dark:text-text-muted">
            <div className={`w-2.5 h-2.5 rounded-sm ${color}`} />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}
