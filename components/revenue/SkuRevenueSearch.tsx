'use client';

import { useState, useEffect, useRef } from 'react';
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts';
import type { SkuRevenueSearchResult } from '@/lib/db/queries';

function Sparkline({ data }: { data: { revenue: number }[] }) {
  if (data.length < 2) return null;
  const chartData = data.map((d) => ({ v: d.revenue }));
  const first = data[0].revenue;
  const last = data[data.length - 1].revenue;
  const trending = last >= first;

  return (
    <ResponsiveContainer width="100%" height={60}>
      <LineChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
        <defs>
          <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={trending ? '#10b981' : '#ef4444'} stopOpacity={0.3} />
            <stop offset="95%" stopColor={trending ? '#10b981' : '#ef4444'} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Tooltip
          contentStyle={{ fontSize: 10, borderRadius: 8, background: '#16161f', border: '1px solid #1e1e2e', color: '#f1f5f9' }}
          formatter={(v: number) => [`$${v.toFixed(2)}`, 'Revenue']}
        />
        <Line
          type="monotone"
          dataKey="v"
          stroke={trending ? '#10b981' : '#ef4444'}
          strokeWidth={2}
          dot={false}
          fill="url(#sparkGrad)"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

const CURRENT_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: 5 }, (_, i) => String(CURRENT_YEAR - i));
const MONTHS = [
  { value: '01', label: 'Jan' }, { value: '02', label: 'Feb' },
  { value: '03', label: 'Mar' }, { value: '04', label: 'Apr' },
  { value: '05', label: 'May' }, { value: '06', label: 'Jun' },
  { value: '07', label: 'Jul' }, { value: '08', label: 'Aug' },
  { value: '09', label: 'Sep' }, { value: '10', label: 'Oct' },
  { value: '11', label: 'Nov' }, { value: '12', label: 'Dec' },
];

function formatUSD(v: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}

export default function SkuRevenueSearch() {
  const [skuInput, setSkuInput] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [allSkus, setAllSkus] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [periodType, setPeriodType] = useState<'month' | 'year'>('month');
  const [selectedYear, setSelectedYear] = useState(String(CURRENT_YEAR));
  const [selectedMonth, setSelectedMonth] = useState(String(new Date().getMonth() + 1).padStart(2, '0'));
  const [result, setResult] = useState<SkuRevenueSearchResult | null>(null);
  const [noData, setNoData] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingSkus, setLoadingSkus] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!skuInput.trim()) { setSuggestions([]); return; }
    const q = skuInput.toLowerCase();
    setSuggestions(allSkus.filter((s) => s.toLowerCase().includes(q)).slice(0, 8));
  }, [skuInput, allSkus]);

  const activeSku = result?.sku ?? (noData ? skuInput.trim().toUpperCase() : null);
  useEffect(() => {
    if (!activeSku) return;
    const period = periodType === 'month' ? `${selectedYear}-${selectedMonth}` : selectedYear;
    setLoading(true); setError(null); setResult(null); setNoData(false);
    fetch(`/api/sku-revenue?sku=${encodeURIComponent(activeSku)}&type=${periodType}&period=${period}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        if (!data.result) setNoData(true);
        else setResult(data.result);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Search failed'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodType, selectedYear, selectedMonth]);

  async function handleSearch(skuOverride?: string) {
    const sku = (skuOverride ?? skuInput).trim().toUpperCase();
    if (!sku) return;
    setLoading(true); setError(null); setResult(null); setNoData(false); setShowSuggestions(false);
    const period = periodType === 'month' ? `${selectedYear}-${selectedMonth}` : selectedYear;
    try {
      const res = await fetch(`/api/sku-revenue?sku=${encodeURIComponent(sku)}&type=${periodType}&period=${period}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.result) setNoData(true);
      else setResult(data.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }

  function selectSuggestion(sku: string) {
    setSkuInput(sku); setShowSuggestions(false); handleSearch(sku);
  }

  const periodLabel = periodType === 'month'
    ? `${MONTHS.find((m) => m.value === selectedMonth)?.label} ${selectedYear}`
    : selectedYear;

  const pillBase = 'px-3 py-1.5 rounded-full text-xs font-medium transition-colors';
  const pillActive = 'bg-accent-primary text-white';
  const pillInactive = 'bg-gray-100 dark:bg-surface-elevated text-gray-600 dark:text-text-secondary hover:bg-gray-200 dark:hover:bg-surface-hover';

  return (
    <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 dark:border-surface-border">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-text-primary">SKU Revenue Search</h3>
        <p className="text-xs text-gray-400 dark:text-text-muted mt-0.5">Look up total revenue &amp; units sold for any SKU by month or year</p>
      </div>

      <div className="px-5 py-4 space-y-3">
        {/* Period type */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500 dark:text-text-muted">Period:</span>
          <div className="flex items-center gap-1 bg-gray-100 dark:bg-surface-elevated rounded-full p-1">
            <button onClick={() => setPeriodType('month')} className={`${pillBase} ${periodType === 'month' ? pillActive : pillInactive}`}>Month</button>
            <button onClick={() => setPeriodType('year')} className={`${pillBase} ${periodType === 'year' ? pillActive : pillInactive}`}>Year</button>
          </div>
        </div>

        {/* Year + month */}
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={selectedYear}
            onChange={(e) => setSelectedYear(e.target.value)}
            className="text-xs border border-gray-200 dark:border-surface-border rounded-lg px-2 py-1.5 bg-white dark:bg-surface-elevated text-gray-700 dark:text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary"
            aria-label="Select year"
          >
            {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          {periodType === 'month' && (
            <div className="flex flex-wrap gap-1">
              {MONTHS.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setSelectedMonth(m.value)}
                  className={`px-2 py-1 rounded-full text-xs font-medium transition-colors ${
                    selectedMonth === m.value ? pillActive : pillInactive
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* SKU input */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              ref={inputRef}
              type="text"
              value={skuInput}
              onChange={(e) => { setSkuInput(e.target.value.toUpperCase()); setShowSuggestions(true); }}
              onFocus={() => {
                setShowSuggestions(true);
                if (allSkus.length === 0 && !loadingSkus) {
                  setLoadingSkus(true);
                  fetch('/api/sku-revenue?list=1')
                    .then((r) => r.json())
                    .then((d) => setAllSkus(d.skus ?? []))
                    .catch(() => {})
                    .finally(() => setLoadingSkus(false));
                }
              }}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
              placeholder="e.g. AM5237"
              className="w-full text-sm border border-gray-200 dark:border-surface-border rounded-xl px-3 py-2 font-mono bg-white dark:bg-surface-elevated text-gray-900 dark:text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary placeholder:text-gray-300 dark:placeholder:text-text-muted placeholder:font-sans"
              aria-label="SKU search input"
              aria-autocomplete="list"
              aria-expanded={showSuggestions && suggestions.length > 0}
            />
            {showSuggestions && suggestions.length > 0 && (
              <ul className="absolute z-20 top-full left-0 right-0 mt-1 bg-white dark:bg-surface-card border border-gray-200 dark:border-surface-border rounded-xl shadow-xl overflow-hidden" role="listbox">
                {suggestions.map((s) => (
                  <li
                    key={s}
                    role="option"
                    aria-selected={skuInput === s}
                    onMouseDown={() => selectSuggestion(s)}
                    className="px-3 py-2 text-sm font-mono text-gray-700 dark:text-text-primary hover:bg-surface-hover dark:hover:bg-surface-hover cursor-pointer"
                  >
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            onClick={() => handleSearch()}
            disabled={loading || !skuInput.trim()}
            className="px-4 py-2 text-sm font-medium bg-accent-primary text-white rounded-xl hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : 'Search'}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-5 mb-4 bg-red-950 border border-red-800 rounded-xl p-4 text-red-300 text-xs">
          ✗ {error}
          <button onClick={() => handleSearch()} className="ml-2 underline">Retry</button>
        </div>
      )}

      {/* No data */}
      {noData && (
        <div className="px-5 pb-4 text-xs text-gray-400 dark:text-text-muted">
          No data for <span className="font-mono font-semibold">{skuInput}</span> in {periodLabel}.
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="border-t border-gray-100 dark:border-surface-border">
          <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <div className="text-[10px] font-semibold text-gray-400 dark:text-text-muted uppercase tracking-wider mb-1">SKU</div>
              <div className="text-sm font-bold text-gray-900 dark:text-text-primary font-mono">{result.sku}</div>
              <div className="text-[10px] text-gray-400 dark:text-text-muted mt-0.5">{periodLabel}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold text-gray-400 dark:text-text-muted uppercase tracking-wider mb-1">Total Revenue</div>
              <div className="text-lg font-bold text-accent-emerald tabular-nums">{formatUSD(result.totalRevenue)}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold text-gray-400 dark:text-text-muted uppercase tracking-wider mb-1">Units Sold</div>
              <div className="text-lg font-bold text-gray-800 dark:text-text-primary tabular-nums">{result.totalUnits.toLocaleString()}</div>
              <div className="text-[10px] text-gray-400 dark:text-text-muted mt-0.5">avg {formatUSD(result.avgUnitPrice)}/unit</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold text-gray-400 dark:text-text-muted uppercase tracking-wider mb-1">Trend</div>
              {result.dailyTrend.length >= 2 ? (
                <Sparkline data={result.dailyTrend} />
              ) : (
                <span className="text-xs text-gray-400 dark:text-text-muted">Single day</span>
              )}
              <div className="text-[10px] text-gray-400 dark:text-text-muted mt-0.5">
                {result.orderCount.toLocaleString()} order{result.orderCount !== 1 ? 's' : ''}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
