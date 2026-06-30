'use client';

import { useState, useEffect } from 'react';
import { DailySummary } from '@/lib/data/types';
import OrderVolumeChart from './OrderVolumeChart';
import RevenueChart from './RevenueChart';
import SkuRevenueChart from './SkuRevenueChart';
import RevenueOrdersChart from './RevenueOrdersChart';

type Period = 7 | 30 | 90 | 365;
type YearFilter = number | null;

const PERIOD_LABELS: Record<Period, string> = {
  7: '7d',
  30: '30d',
  90: '90d',
  365: '1y',
};

// Dynamic: current year ± 2
const YEAR_OPTIONS = Array.from({ length: 3 }, (_, i) => new Date().getFullYear() - 2 + i);

interface ChartContainerProps {
  summaries: DailySummary[];
  defaultPeriod?: Period;
}

function ChartCard({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-surface-card border border-gray-100 dark:border-surface-border rounded-2xl p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-text-primary">{title}</h3>
        {extra}
      </div>
      {children}
    </div>
  );
}

export default function ChartContainer({
  summaries,
  defaultPeriod = 7,
}: ChartContainerProps) {
  const [period, setPeriod] = useState<Period>(defaultPeriod);
  const [yearFilter, setYearFilter] = useState<YearFilter>(null);
  const [yearCache, setYearCache] = useState<Record<number, DailySummary[]>>({});
  const [yearLoading, setYearLoading] = useState(false);

  useEffect(() => {
    if (yearFilter === null) return;
    if (yearCache[yearFilter]) return;
    setYearLoading(true);
    fetch(`/api/summaries?year=${yearFilter}`)
      .then((r) => r.json())
      .then((data: DailySummary[]) => {
        setYearCache((prev) => ({ ...prev, [yearFilter]: data }));
      })
      .catch(console.error)
      .finally(() => setYearLoading(false));
  }, [yearFilter, yearCache]);

  const sorted = [...summaries].sort((a, b) => a.date.localeCompare(b.date));
  const sliced = yearFilter !== null ? (yearCache[yearFilter] ?? []) : sorted.slice(-period);
  const rangeLabel = yearFilter !== null ? String(yearFilter) : `Trailing ${PERIOD_LABELS[period]}`;

  function handleYearClick(year: number) {
    setYearFilter(yearFilter === year ? null : year);
  }

  function handlePeriodClick(p: Period) {
    setPeriod(p);
    setYearFilter(null);
  }

  const pillBase = 'px-3 py-1.5 rounded-full text-xs font-medium transition-colors';
  const pillActive = 'bg-accent-primary text-white';
  const pillInactive = 'bg-gray-100 dark:bg-surface-elevated text-gray-600 dark:text-text-secondary hover:bg-gray-200 dark:hover:bg-surface-hover';

  const yearPillActive = 'bg-accent-violet text-white';

  const loadingEl = (
    <div className="flex items-center justify-center h-40">
      <div className="space-y-2 w-full px-4">
        <div className="h-3 bg-surface-elevated dark:bg-surface-elevated bg-gray-100 rounded animate-pulse" />
        <div className="h-3 bg-surface-elevated dark:bg-surface-elevated bg-gray-100 rounded animate-pulse w-4/5" />
        <div className="h-3 bg-surface-elevated dark:bg-surface-elevated bg-gray-100 rounded animate-pulse w-3/5" />
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1.5 bg-gray-100 dark:bg-surface-elevated rounded-full p-1">
          {(Object.keys(PERIOD_LABELS) as unknown as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => handlePeriodClick(p)}
              className={`${pillBase} ${yearFilter === null && period === p ? pillActive : pillInactive}`}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>

        <span className="text-gray-300 dark:text-surface-border text-sm hidden sm:inline">|</span>

        <div className="flex items-center gap-1.5 bg-gray-100 dark:bg-surface-elevated rounded-full p-1">
          {YEAR_OPTIONS.map((year) => (
            <button
              key={year}
              onClick={() => handleYearClick(year)}
              className={`${pillBase} ${yearFilter === year ? yearPillActive : pillInactive}`}
            >
              {year}
            </button>
          ))}
        </div>
      </div>

      {/* 2-col charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard title="Daily Order Volume">
          {yearLoading ? loadingEl : (
            <OrderVolumeChart summaries={sliced} period={yearFilter !== null ? sliced.length : period} />
          )}
        </ChartCard>
        <ChartCard title="Daily Revenue">
          {yearLoading ? loadingEl : (
            <RevenueChart summaries={sliced} period={yearFilter !== null ? sliced.length : period} />
          )}
        </ChartCard>
      </div>

      {/* SKU Revenue */}
      <ChartCard title="Revenue by SKU — Top 10" extra={<span className="text-xs text-gray-400 dark:text-text-muted">{rangeLabel}</span>}>
        {yearLoading ? loadingEl : <SkuRevenueChart summaries={sliced} topN={10} />}
      </ChartCard>

      {/* Revenue vs Orders combo */}
      <ChartCard title="Revenue vs Orders" extra={<span className="text-xs text-gray-400 dark:text-text-muted">{rangeLabel}</span>}>
        {yearLoading ? loadingEl : (
          <RevenueOrdersChart summaries={sliced} period={yearFilter !== null ? sliced.length : period} />
        )}
      </ChartCard>
    </div>
  );
}
