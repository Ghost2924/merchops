'use client';

import { useState, useEffect } from 'react';
import { DailySummary } from '@/lib/data/types';
import { formatUSD } from '@/lib/formatters';
import { ChevronDown, ChevronUp, Trophy } from 'lucide-react';

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

interface YearSummary {
  year: number;
  totalRevenue: number;
  totalOrders: number;
  aov: number;
  dailySummaries: DailySummary[];
}

interface MonthSummary {
  month: number;
  label: string;
  totalRevenue: number;
  totalOrders: number;
  aov: number;
}

function buildYears(summaries: DailySummary[]): YearSummary[] {
  const byYear = new Map<number, DailySummary[]>();
  for (const s of summaries) {
    const year = parseInt(s.date.slice(0, 4), 10);
    const list = byYear.get(year) ?? [];
    list.push(s);
    byYear.set(year, list);
  }
  return Array.from(byYear.entries())
    .map(([year, days]) => {
      const totalRevenue = days.reduce((sum, d) => sum + d.totalRevenue, 0);
      const totalOrders = days.reduce((sum, d) => sum + d.orderCount, 0);
      return { year, totalRevenue, totalOrders, aov: totalOrders > 0 ? totalRevenue / totalOrders : 0, dailySummaries: days };
    })
    .sort((a, b) => b.year - a.year);
}

function buildMonths(dailySummaries: DailySummary[]): MonthSummary[] {
  const byMonth = new Map<number, DailySummary[]>();
  for (const s of dailySummaries) {
    const month = parseInt(s.date.slice(5, 7), 10);
    const list = byMonth.get(month) ?? [];
    list.push(s);
    byMonth.set(month, list);
  }
  return Array.from(byMonth.entries())
    .map(([month, days]) => {
      const totalRevenue = days.reduce((sum, d) => sum + d.totalRevenue, 0);
      const totalOrders = days.reduce((sum, d) => sum + d.orderCount, 0);
      return { month, label: MONTH_NAMES[month - 1], totalRevenue, totalOrders, aov: totalOrders > 0 ? totalRevenue / totalOrders : 0 };
    })
    .sort((a, b) => b.month - a.month);
}

function CompactDailyRevenue({ summaries, todaySummary }: { summaries: DailySummary[]; todaySummary: DailySummary | null }) {
  const [showAll, setShowAll] = useState(false);
  const PREVIEW = 7;

  const allDays = [...summaries];
  if (todaySummary && !allDays.find((s) => s.date === todaySummary.date)) allDays.push(todaySummary);
  const rows = allDays.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
  const visible = showAll ? rows : rows.slice(0, PREVIEW);

  const total30 = rows.reduce((sum, r) => sum + r.totalRevenue, 0);
  const totalOrders30 = rows.reduce((sum, r) => sum + r.orderCount, 0);
  const avgDaily = rows.length > 0 ? total30 / rows.length : 0;
  const maxRevenue = Math.max(...rows.map((r) => r.totalRevenue), 1);
  const bestDay = rows.reduce((best, r) => r.totalRevenue > best.totalRevenue ? r : best, rows[0]);

  return (
    <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-gray-100 dark:border-surface-border">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-text-primary">Daily Revenue</h3>
            <p className="text-xs text-gray-400 dark:text-text-muted">Last 30 days · newest first</p>
          </div>
          <div className="text-right">
            <p className="text-base font-bold text-gray-900 dark:text-text-primary">{formatUSD(total30)}</p>
            <p className="text-xs text-gray-400 dark:text-text-muted">30-day total</p>
          </div>
        </div>
        <div className="flex gap-2">
          {[
            { label: 'Avg/day', value: formatUSD(avgDaily) },
            { label: 'Orders', value: totalOrders30.toLocaleString() },
            { label: 'Days', value: String(rows.length) },
          ].map(({ label, value }) => (
            <div key={label} className="flex-1 bg-gray-50 dark:bg-surface-elevated rounded-lg px-2 py-1.5 text-center">
              <p className="text-[10px] text-gray-400 dark:text-text-muted leading-none">{label}</p>
              <p className="text-xs font-semibold text-gray-800 dark:text-text-primary mt-0.5">{value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="divide-y divide-gray-50 dark:divide-surface-border flex-1">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-gray-400 dark:text-text-muted">No data</p>
        ) : (
          visible.map((row) => {
            const isToday = row.date === todaySummary?.date;
            const isBest = row.date === bestDay?.date && !isToday;
            const barPct = Math.round((row.totalRevenue / maxRevenue) * 100);
            const [year, month, day] = row.date.split('-').map(Number);
            const label = new Date(year, month - 1, day).toLocaleDateString('en-US', {
              weekday: 'short', month: 'short', day: 'numeric',
            });
            return (
              <div
                key={row.date}
                className={[
                  'px-4 py-2 flex items-center gap-3 text-xs transition-colors',
                  isToday
                    ? 'bg-accent-primary/10 border-l-2 border-l-accent-primary'
                    : isBest
                    ? 'bg-amber-50 dark:bg-amber-950/20'
                    : 'hover:bg-gray-50 dark:hover:bg-surface-hover',
                ].join(' ')}
              >
                <span className="w-28 font-medium text-gray-800 dark:text-text-primary shrink-0 flex items-center gap-1">
                  {isBest && <Trophy size={10} className="text-accent-amber shrink-0" />}
                  {label}
                  {isToday && (
                    <span className="ml-1 text-[10px] font-semibold text-accent-primary bg-accent-primary/10 px-1 py-0.5 rounded-full">
                      today
                    </span>
                  )}
                </span>
                <span className="w-10 text-right text-gray-500 dark:text-text-muted shrink-0">{row.orderCount}</span>
                <div className="flex-1 bg-gray-100 dark:bg-surface-elevated rounded-full h-1">
                  <div
                    className={`h-1 rounded-full ${isToday ? 'bg-accent-primary' : 'bg-accent-emerald'}`}
                    style={{ width: `${barPct}%` }}
                  />
                </div>
                <span className="w-20 text-right font-semibold text-gray-900 dark:text-text-primary shrink-0">
                  {formatUSD(row.totalRevenue)}
                </span>
              </div>
            );
          })
        )}
      </div>

      {rows.length > PREVIEW && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="w-full py-2 text-xs text-accent-primary hover:text-accent-glow border-t border-gray-100 dark:border-surface-border bg-gray-50 dark:bg-surface-elevated hover:bg-gray-100 dark:hover:bg-surface-hover transition-colors font-medium flex items-center justify-center gap-1"
        >
          {showAll ? <><ChevronUp size={12} /> Show less</> : <><ChevronDown size={12} /> Show {rows.length - PREVIEW} more days</>}
        </button>
      )}
    </div>
  );
}

function CompactYearlyRevenue({ summaries }: { summaries: DailySummary[] }) {
  const [expandedYear, setExpandedYear] = useState<number | null>(null);
  const years = buildYears(summaries);

  if (years.length === 0) {
    return (
      <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border p-6 text-center text-xs text-gray-400 dark:text-text-muted">
        No historical data
      </div>
    );
  }

  const maxRevenue = Math.max(...years.map((y) => y.totalRevenue), 1);
  const currentYear = new Date().getFullYear();

  return (
    <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 dark:border-surface-border flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-text-primary">Revenue by Year</h3>
          <p className="text-xs text-gray-400 dark:text-text-muted">Click year for monthly breakdown</p>
        </div>
        <span className="text-xs text-gray-400 dark:text-text-muted">{years.length} yr{years.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="divide-y divide-gray-50 dark:divide-surface-border">
        {years.map((y) => {
          const isExpanded = expandedYear === y.year;
          const isCurrent = y.year === currentYear;
          const barPct = Math.round((y.totalRevenue / maxRevenue) * 100);
          const months = isExpanded ? buildMonths(y.dailySummaries) : [];
          const maxMonthRevenue = isExpanded ? Math.max(...months.map((m) => m.totalRevenue), 1) : 1;

          return (
            <div key={y.year}>
              <button
                onClick={() => setExpandedYear(isExpanded ? null : y.year)}
                className={[
                  'w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors text-xs',
                  isExpanded
                    ? 'bg-accent-primary/10 dark:bg-accent-primary/10'
                    : 'hover:bg-gray-50 dark:hover:bg-surface-hover',
                ].join(' ')}
              >
                {isExpanded ? <ChevronDown size={12} className="text-gray-400 shrink-0" /> : <ChevronDown size={12} className="text-gray-400 shrink-0 -rotate-90" />}
                <span className="w-14 font-bold text-gray-900 dark:text-text-primary text-sm shrink-0">
                  {y.year}
                  {isCurrent && (
                    <span className="ml-1 text-[10px] font-semibold text-accent-primary bg-accent-primary/10 px-1 py-0.5 rounded-full">YTD</span>
                  )}
                </span>
                <div className="flex-1 grid grid-cols-3 gap-2">
                  <div>
                    <span className="text-[10px] text-gray-400 dark:text-text-muted block leading-none">Revenue</span>
                    <span className="font-semibold text-gray-900 dark:text-text-primary">{formatUSD(y.totalRevenue)}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-gray-400 dark:text-text-muted block leading-none">Orders</span>
                    <span className="font-semibold text-gray-700 dark:text-text-secondary">{y.totalOrders.toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-gray-400 dark:text-text-muted block leading-none">AOV</span>
                    <span className="font-semibold text-gray-700 dark:text-text-secondary">{formatUSD(y.aov)}</span>
                  </div>
                </div>
                <div className="w-20 hidden sm:block shrink-0">
                  <div className="w-full bg-gray-100 dark:bg-surface-elevated rounded-full h-1">
                    <div
                      className={`h-1 rounded-full ${isCurrent ? 'bg-accent-primary' : 'bg-accent-emerald'}`}
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                </div>
              </button>

              {isExpanded && (
                <div className="bg-gray-50 dark:bg-surface-elevated border-t border-gray-100 dark:border-surface-border divide-y divide-gray-100 dark:divide-surface-border">
                  {months.map((m) => {
                    const mBarPct = Math.round((m.totalRevenue / maxMonthRevenue) * 100);
                    return (
                      <div key={m.month} className="pl-10 pr-4 py-2 flex items-center gap-3 text-xs hover:bg-white dark:hover:bg-surface-hover transition-colors">
                        <span className="w-8 font-medium text-gray-600 dark:text-text-secondary shrink-0">{m.label}</span>
                        <div className="flex-1 grid grid-cols-3 gap-2">
                          <span className="font-semibold text-gray-900 dark:text-text-primary">{formatUSD(m.totalRevenue)}</span>
                          <span className="text-gray-600 dark:text-text-secondary">{m.totalOrders.toLocaleString()}</span>
                          <span className="text-gray-500 dark:text-text-muted">{formatUSD(m.aov)}</span>
                        </div>
                        <div className="w-20 hidden sm:block shrink-0">
                          <div className="w-full bg-gray-200 dark:bg-surface-border rounded-full h-1">
                            <div className="h-1 rounded-full bg-accent-emerald" style={{ width: `${mBarPct}%` }} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div className="pl-10 pr-4 py-2 flex items-center gap-3 text-xs bg-white dark:bg-surface-card border-t border-gray-200 dark:border-surface-border">
                    <span className="w-8 font-semibold text-gray-500 dark:text-text-muted uppercase shrink-0">Tot</span>
                    <div className="flex-1 grid grid-cols-3 gap-2">
                      <span className="font-bold text-gray-900 dark:text-text-primary">{formatUSD(y.totalRevenue)}</span>
                      <span className="font-bold text-gray-900 dark:text-text-primary">{y.totalOrders.toLocaleString()}</span>
                      <span className="text-gray-500 dark:text-text-muted">{formatUSD(y.aov)}</span>
                    </div>
                    <div className="w-20 hidden sm:block shrink-0" />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface CompactRevenuePanelProps {
  summaries: DailySummary[];
  historicalSummaries?: DailySummary[]; // kept for compat but ignored — fetched client-side
  todaySummary: DailySummary | null;
}

export default function CompactRevenuePanel({ summaries, todaySummary }: CompactRevenuePanelProps) {
  const [historicalSummaries, setHistoricalSummaries] = useState<DailySummary[]>([]);

  useEffect(() => {
    fetch('/api/summaries?all=true')
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setHistoricalSummaries(data); })
      .catch(() => { /* non-fatal — yearly panel shows what it has */ });
  }, []);

  // Merge recent + historical, deduplicate by date, for the yearly panel
  const allSummaries = (() => {
    const byDate = new Map<string, DailySummary>();
    for (const s of historicalSummaries) byDate.set(s.date, s);
    // Recent summaries take precedence (have zero-fill for current window)
    for (const s of summaries) {
      if (s.totalRevenue > 0 || !byDate.has(s.date)) byDate.set(s.date, s);
    }
    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  })();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <CompactDailyRevenue summaries={summaries} todaySummary={todaySummary} />
      <CompactYearlyRevenue summaries={allSummaries} />
    </div>
  );
}
