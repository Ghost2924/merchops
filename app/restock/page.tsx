'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, useMemo } from 'react';
import { RestockRow, StorefrontMapping } from '@/lib/db/queries';
import { StockHistoryPanel } from '@/components/inventory/StockHistoryPanel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function CoverBar({ daysOfCover, reorderTrigger }: { daysOfCover: number | null; reorderTrigger: number }) {
  if (daysOfCover === null) {
    return <div className="text-xs text-gray-400 dark:text-text-muted mt-1">No velocity data</div>;
  }
  const critical   = daysOfCover < reorderTrigger;
  const primaryPct = Math.min((daysOfCover / reorderTrigger) * 100, 100);
  const MAX_DISPLAY = reorderTrigger * 2;
  const cushionPct  = daysOfCover > reorderTrigger
    ? Math.min(((daysOfCover - reorderTrigger) / MAX_DISPLAY) * 100, 50)
    : 0;

  return (
    <div className="mt-1.5">
      <div className="text-xs text-gray-400 dark:text-text-muted mb-1">{daysOfCover}d cover</div>
      <div className="relative h-1.5 w-24 bg-gray-100 dark:bg-surface-elevated rounded-full overflow-hidden">
        {critical ? (
          <div className="absolute left-0 top-0 h-full bg-accent-red rounded-full" style={{ width: `${primaryPct}%` }} />
        ) : (
          <>
            <div className="absolute left-0 top-0 h-full bg-accent-emerald rounded-full" style={{ width: `${primaryPct}%` }} />
            {cushionPct > 0 && (
              <div className="absolute top-0 h-full bg-emerald-200 rounded-full" style={{ left: `${primaryPct}%`, width: `${cushionPct}%` }} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function VelocityCell({ row }: { row: RestockRow }) {
  const { velocity_90d, velocity_adj, velocity_in_stock_days } = row;
  return (
    <div className="flex items-center justify-end gap-1.5">
      <span className="tabular-nums text-gray-700 dark:text-text-secondary">{velocity_90d.toFixed(2)}</span>
      {velocity_adj && (
        <span className="group relative inline-flex items-center">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-900 text-indigo-300 cursor-default select-none">
            Adj
          </span>
          <span className="pointer-events-none absolute bottom-full right-0 mb-1.5 w-64 rounded-xl bg-surface-elevated px-3 py-2 text-xs text-text-primary shadow-xl opacity-0 group-hover:opacity-100 transition-opacity z-20 leading-relaxed border border-surface-border">
            Velocity over <strong>{velocity_in_stock_days} in-stock days</strong> in last 90d (OOS-corrected, capped at raw/90 × 1.25).
          </span>
        </span>
      )}
    </div>
  );
}

function GrowthPill({ row }: { row: RestockRow }) {
  if (!row.has_ly_data) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-surface-elevated text-gray-400 dark:text-text-muted">
        — No LY data
      </span>
    );
  }
  const pct = Math.round((row.growth_multiplier - 1) * 100);
  if (pct === 0)
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 dark:bg-surface-elevated text-gray-500 dark:text-text-secondary">→ 0%</span>;
  if (pct > 0)
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-900 text-emerald-300">↗ +{pct}%</span>;
  return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-900 text-red-300">↘ {pct}%</span>;
}

function ForecastTooltip({ row }: { row: RestockRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        className="tabular-nums text-gray-700 dark:text-text-secondary underline decoration-dotted underline-offset-2 cursor-help"
        onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        aria-expanded={open} aria-haspopup="true"
      >
        {row.forecast.toLocaleString()}
      </button>
      {open && (
        <div
          className="absolute bottom-full right-0 mb-2 z-30 w-72 rounded-xl bg-surface-elevated text-text-primary shadow-2xl p-4 text-xs leading-relaxed border border-surface-border"
          role="tooltip"
        >
          <div className="font-semibold text-text-secondary mb-2 text-[11px] uppercase tracking-wider">Forecast Breakdown</div>
          <div className="space-y-1 font-mono">
            <div className="flex justify-between"><span className="text-text-muted">Vel forecast</span><span>{row.vel_forecast.toLocaleString()} u</span></div>
            <div className="flex justify-between"><span className="text-text-muted">Seasonal forecast</span><span>{row.seas_forecast > 0 ? `${row.seas_forecast.toLocaleString()} u` : '—'}</span></div>
            <div className="flex justify-between"><span className="text-text-muted">Blend weight</span><span>{row.has_ly_data && row.seas_forecast > 0 ? '50/50' : 'vel only'}</span></div>
            <div className="border-t border-surface-border my-1.5" />
            <div className="flex justify-between"><span className="text-text-muted">YoY growth</span><span>{Math.round((row.growth_multiplier - 1) * 100) >= 0 ? '+' : ''}{Math.round((row.growth_multiplier - 1) * 100)}%</span></div>
            <div className="flex justify-between"><span className="text-text-muted">Horizon</span><span>{row.lead_time_days + 90}d ({row.lead_time_days}d lead + 90d cover)</span></div>
            <div className="border-t border-surface-border my-1.5" />
            <div className="flex justify-between font-semibold"><span className="text-text-secondary">Blended forecast</span><span>{row.forecast.toLocaleString()} u</span></div>
            <div className="border-t border-surface-border my-1.5" />
            <div className="flex justify-between"><span className="text-text-muted">LY daily rate</span><span>{row.ly_daily_rate.toFixed(3)} u/d</span></div>
            <div className="flex justify-between"><span className="text-text-muted">Declining flag</span><span>{row.is_declining ? '⚠️ yes' : 'no'}</span></div>
            <div className="flex justify-between"><span className="text-text-muted">Status driver</span><span className="text-right max-w-[160px] break-words">{row.status_driver}</span></div>
          </div>
          <div className="absolute -bottom-1.5 right-4 w-3 h-3 bg-surface-elevated rotate-45 border-r border-b border-surface-border" />
        </div>
      )}
    </div>
  );
}

function StatusBadge({ row }: { row: RestockRow }) {
  const title = row.status_driver;
  if (row.status === 'REORDER NOW') {
    return (
      <span title={title} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-900 text-red-300 ring-1 ring-red-700 cursor-help">
        REORDER NOW
      </span>
    );
  }
  if (row.status === 'OVERSTOCKED') {
    return (
      <span title={title} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-900 text-purple-300 ring-1 ring-purple-700 cursor-help">
        OVERSTOCKED
      </span>
    );
  }
  if (row.status === 'DECLINING') {
    return (
      <span title={title} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-900 text-amber-300 ring-1 ring-amber-700 cursor-help">
        DECLINING
      </span>
    );
  }
  return (
    <span title={title} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-900 text-emerald-300 ring-1 ring-emerald-700 cursor-help">
      OK
    </span>
  );
}

function StorefrontBadges({ mappings }: { mappings?: StorefrontMapping[] }) {
  const [expanded, setExpanded] = useState(false);

  const grouped = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!mappings) return map;
    for (const m of mappings) {
      const displaySku = m.mapped_sku.replace(/^AM(\d)/, '$1');
      const list = map.get(displaySku) ?? [];
      if (m.storefront_sku && m.storefront_sku !== m.mapped_sku) {
        list.push(m.storefront_sku);
      }
      map.set(displaySku, list);
    }
    return map;
  }, [mappings]);

  if (!mappings || mappings.length === 0) return null;

  const entries = [...grouped.entries()];
  const showLimit = 3;
  const hasMore = entries.length > showLimit;
  const visibleEntries = expanded ? entries : entries.slice(0, showLimit);

  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex flex-wrap gap-1.5 max-w-[380px]">
        {visibleEntries.map(([mappedSku, asins]) => (
          <span
            key={mappedSku}
            title={asins.length > 0 ? `Storefront SKU(s): ${asins.join(', ')}` : undefined}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-50 dark:bg-surface-elevated text-gray-500 dark:text-text-secondary border border-gray-200/60 dark:border-surface-border font-mono cursor-help"
          >
            📦 {mappedSku}
            {asins.length > 0 && (
              <span className="text-[9px] text-gray-400 dark:text-text-muted">
                ({asins[0]}{asins.length > 1 ? ` +${asins.length - 1}` : ''})
              </span>
            )}
          </span>
        ))}
      </div>
      {hasMore && (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setExpanded(!expanded); }}
          className="text-left text-[10px] font-medium text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 w-fit select-none focus:outline-none"
        >
          {expanded ? 'Show less ▲' : `+ ${entries.length - showLimit} more combo SKUs ▼`}
        </button>
      )}
    </div>
  );
}

function LyMonthlyCell({ row }: { row: RestockRow }) {
  if (!row.ly_monthly_units || row.ly_monthly_units.length === 0) {
    return <span className="text-gray-400 dark:text-text-muted text-xs">—</span>;
  }
  return (
    <div className="flex flex-col gap-0.5 items-end">
      {row.ly_monthly_units.map((m) => (
        <div key={m.month} className="flex items-center gap-1.5 text-xs">
          <span className="text-gray-400 dark:text-text-muted w-16 text-right">{m.month}</span>
          <span className={`tabular-nums font-medium ${m.units > 0 ? 'text-gray-700 dark:text-text-secondary' : 'text-gray-300 dark:text-text-muted'}`}>
            {m.units > 0 ? m.units.toLocaleString() : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}


function exportCsv(rows: RestockRow[]) {
  if (rows.length === 0) return;
  const cols: (keyof RestockRow)[] = [
    'sku', 'qty_available', 'on_order', 'velocity_90d', 'lead_time_days',
    'days_of_cover', 'forecast', 'vel_forecast', 'seas_forecast', 'safety_stock',
    'order_now', 'order_moq', 'status', 'units_30d', 'ly_daily_rate', 'is_declining', 'status_driver',
  ];
  const csv = [
    cols.join(','),
    ...rows.map((r) => cols.map((k) => JSON.stringify(r[k] ?? '')).join(',')),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `restock-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Mobile card
// ---------------------------------------------------------------------------
function SkuCard({ row }: { row: RestockRow }) {
  const reorderTrigger = row.lead_time_days + Math.round(row.lead_time_days * 0.25);
  return (
    <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-200 dark:border-surface-border shadow-sm overflow-hidden">
      <div className="flex flex-col px-4 pt-4 pb-3">
        <div className="flex items-center justify-between">
          <span className="font-bold text-gray-900 dark:text-text-primary font-mono text-base">{row.sku}</span>
          <StatusBadge row={row} />
        </div>
        <StorefrontBadges mappings={row.storefront_mappings} />
        <StockHistoryPanel sku={row.sku} />
      </div>
      <div className="grid grid-cols-2 gap-px bg-gray-100 dark:bg-surface-border border-t border-gray-100 dark:border-surface-border">
        {[
          {
            label: 'On Hand',
            content: (
              <>
                <div className="text-sm font-semibold text-gray-800 dark:text-text-primary tabular-nums">{row.qty_available.toLocaleString()}</div>
                <CoverBar daysOfCover={row.days_of_cover} reorderTrigger={reorderTrigger} />
              </>
            ),
          },
          {
            label: 'Velocity / day',
            content: <VelocityCell row={row} />,
          },
          {
            label: 'YoY Growth',
            content: <GrowthPill row={row} />,
          },
          {
            label: '30D Units',
            content: (
              <span className={`text-sm tabular-nums font-semibold ${row.units_30d > 0 ? 'text-sky-400' : 'text-gray-400 dark:text-text-muted'}`}>
                {row.units_30d > 0 ? row.units_30d.toLocaleString() : '—'}
              </span>
            ),
          },
          {
            label: 'Forecast',
            content: (
              <div className="text-sm tabular-nums text-gray-700 dark:text-text-secondary">
                <ForecastTooltip row={row} />
              </div>
            ),
          },
        ].map(({ label, content }) => (
          <div key={label} className="bg-gray-50 dark:bg-surface-elevated px-4 py-3">
            <div className="text-[11px] font-semibold text-gray-400 dark:text-text-muted uppercase tracking-wider mb-1">{label}</div>
            {content}
          </div>
        ))}
      </div>
      <div className={`flex items-center justify-between px-4 py-3 ${row.status === 'REORDER NOW' ? 'bg-blue-950/30' : row.status === 'OVERSTOCKED' ? 'bg-purple-950/30' : row.status === 'DECLINING' ? 'bg-amber-950/30' : 'bg-gray-50 dark:bg-surface-elevated'}`}>
        <span className="text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider">Order (MOQ)</span>
        <span className={`text-xl font-bold tabular-nums ${row.order_moq > 0 ? 'text-blue-400' : 'text-gray-400 dark:text-text-muted'}`}>
          {row.order_moq > 0 ? row.order_moq.toLocaleString() : '—'}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop table
// ---------------------------------------------------------------------------
type SortKey = keyof RestockRow;

function RestockTable({ rows }: { rows: RestockRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('order_now');
  const [sortAsc, setSortAsc]  = useState(false);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(key === 'sku' || key === 'days_of_cover'); }
  }

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const av = a[sortKey] ?? (sortAsc ? Infinity : -Infinity);
      const bv = b[sortKey] ?? (sortAsc ? Infinity : -Infinity);
      return sortAsc ? (av < bv ? -1 : av > bv ? 1 : 0) : (av > bv ? -1 : av < bv ? 1 : 0);
    });
  }, [rows, sortKey, sortAsc]);

  const reorderCount = useMemo(() => rows.filter((r) => r.status === 'REORDER NOW').length, [rows]);
  const thCls = 'px-4 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-text-primary select-none';
  const arrow = (k: SortKey) => sortKey === k ? (sortAsc ? ' ↑' : ' ↓') : '';

  // Derive LY month labels from first row (all rows share same months)
  const lyMonthLabels = sorted[0]?.ly_monthly_units?.map((m) => m.month) ?? [];

  return (
    <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-200 dark:border-surface-border overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-surface-border bg-gray-50 dark:bg-surface-elevated">
              <th className={`${thCls} text-left`}         onClick={() => toggleSort('sku')}>SKU{arrow('sku')}</th>
              <th className={`${thCls} text-right`}        onClick={() => toggleSort('qty_available')}>On Hand{arrow('qty_available')}</th>
              <th className={`${thCls} text-right`}        onClick={() => toggleSort('on_order')}>On Order{arrow('on_order')}</th>
              <th className={`${thCls} text-right`}        onClick={() => toggleSort('velocity_90d')}>Velocity{arrow('velocity_90d')}</th>
              <th className={`${thCls} text-right`}        onClick={() => toggleSort('lead_time_days')}>Lead Time{arrow('lead_time_days')}</th>
              <th className={`${thCls} text-right`}        onClick={() => toggleSort('days_of_cover')}>Days of Cover{arrow('days_of_cover')}</th>
              <th className={`${thCls} text-right`}        onClick={() => toggleSort('forecast')}>Forecast{arrow('forecast')}</th>
              <th className={`${thCls} text-right`}        onClick={() => toggleSort('safety_stock')}>Safety Stock{arrow('safety_stock')}</th>
              <th className={`${thCls} text-right bg-blue-50 dark:bg-blue-950/30 text-gray-900 dark:text-text-primary`} onClick={() => toggleSort('order_now')}>Order Now{arrow('order_now')}</th>
              <th className={`${thCls} text-right bg-blue-50 dark:bg-blue-950/30 text-gray-900 dark:text-text-primary`} onClick={() => toggleSort('order_moq')}>Order (MOQ){arrow('order_moq')}</th>
              <th className={`${thCls} text-right bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400`} title="Units sold in same months last year">
                LY Monthly Sales
                {lyMonthLabels.length > 0 && (
                  <div className="text-[10px] font-normal text-amber-500 dark:text-amber-500/70 normal-case tracking-normal mt-0.5">
                    {lyMonthLabels.join(' · ')}
                  </div>
                )}
              </th>
              <th className={`${thCls} text-right bg-sky-50 dark:bg-sky-950/20 text-sky-700 dark:text-sky-400`} title="Units sold in the trailing 30 days">
                30D Units
              </th>
              <th className={`${thCls} text-center`}>Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-surface-border">
            {sorted.map((row) => {
              const reorderTrigger = row.lead_time_days + Math.round(row.lead_time_days * 0.25);
              return (
                <tr key={row.sku} className="hover:bg-gray-50 dark:hover:bg-surface-hover transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 dark:text-text-primary font-mono">{row.sku}</div>
                    <StorefrontBadges mappings={row.storefront_mappings} />
                    <StockHistoryPanel sku={row.sku} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700 dark:text-text-secondary">
                    {row.qty_available.toLocaleString()}
                    <CoverBar daysOfCover={row.days_of_cover} reorderTrigger={reorderTrigger} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-500 dark:text-text-muted">
                    {row.on_order > 0 ? row.on_order.toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right"><VelocityCell row={row} /></td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-600 dark:text-text-secondary">{row.lead_time_days}d</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700 dark:text-text-secondary">
                    {row.days_of_cover !== null ? `${row.days_of_cover}d` : '—'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700 dark:text-text-secondary">
                    <ForecastTooltip row={row} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-600 dark:text-text-secondary">
                    {row.safety_stock.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right bg-blue-50 dark:bg-blue-950/30">
                    <span className={`text-base font-bold tabular-nums ${row.order_now > 0 ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-text-muted'}`}>
                      {row.order_now > 0 ? row.order_now.toLocaleString() : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right bg-blue-50 dark:bg-blue-950/30">
                    <span className={`text-base font-bold tabular-nums ${row.order_moq > 0 ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-text-muted'}`}>
                      {row.order_moq > 0 ? row.order_moq.toLocaleString() : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right bg-amber-50 dark:bg-amber-950/20">
                    <LyMonthlyCell row={row} />
                  </td>
                  <td className="px-4 py-3 text-right bg-sky-50 dark:bg-sky-950/20">
                    <span className={`tabular-nums font-semibold text-sm ${row.units_30d > 0 ? 'text-sky-700 dark:text-sky-300' : 'text-gray-300 dark:text-text-muted'}`}>
                      {row.units_30d > 0 ? row.units_30d.toLocaleString() : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center"><StatusBadge row={row} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-gray-100 dark:border-surface-border px-4 py-3 bg-gray-50 dark:bg-surface-elevated flex items-center justify-between text-xs text-gray-400 dark:text-text-muted">
        <span>{rows.length} SKUs · {reorderCount} need reorder</span>
        <span>Forecast = vel-only + seasonal×growth blend · OVERSTOCKED/DECLINING skip order · hover status badge for driver</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function RestockPage() {
  const [rows, setRows]       = useState<RestockRow[]>([]);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [skuSearch, setSkuSearch] = useState('');

  useEffect(() => {
    fetch('/api/restock-plan')
      .then((r) => r.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.error ?? 'Unknown error');
        setRows(Array.isArray(data.data) ? data.data : []);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const filteredRows = useMemo(() => {
    if (!skuSearch.trim()) return rows;
    const q = skuSearch.trim().toLowerCase();
    return rows.filter((r) =>
      r.sku.toLowerCase().includes(q) ||
      r.storefront_mappings?.some(
        (m) => m.storefront_sku?.toLowerCase().includes(q) || m.mapped_sku?.toLowerCase().includes(q)
      )
    );
  }, [rows, skuSearch]);

  const reorderCount     = useMemo(() => rows.filter((r) => r.status === 'REORDER NOW').length, [rows]);
  const totalUnitsNeeded = useMemo(() => rows.reduce((s, r) => s + (r.order_moq > 0 ? r.order_moq : 0), 0), [rows]);

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-surface">
      {/* Header */}
      <div className="bg-white dark:bg-surface-card border-b border-gray-200 dark:border-surface-border px-4 md:px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-text-primary">Restock Planner</h1>
            <p className="text-xs text-gray-400 dark:text-text-muted mt-0.5">
              Velocity + seasonal blend · OOS-corrected · sorted by Order Now
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {reorderCount > 0 && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold bg-red-950 text-red-300 ring-1 ring-red-700">
                <span className="w-2 h-2 rounded-full bg-accent-red animate-pulse" />
                {reorderCount} SKU{reorderCount !== 1 ? 's' : ''} need ordering
              </span>
            )}
            {totalUnitsNeeded > 0 && (
              <span className="text-xs text-gray-400 dark:text-text-muted hidden md:block">
                Est. total units: {totalUnitsNeeded.toLocaleString()}
              </span>
            )}
            <button
              onClick={() => exportCsv(rows)}
              className="px-3 py-1.5 text-xs font-medium bg-surface-elevated dark:bg-surface-elevated text-text-secondary dark:text-text-secondary border border-surface-border rounded-lg hover:bg-surface-hover transition-colors"
            >
              ↓ Export CSV
            </button>
          </div>
        </div>

        {/* SKU search bar */}
        <div className="max-w-7xl mx-auto mt-3">
          <div className="relative w-full max-w-sm">
            <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-text-muted" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="text"
              value={skuSearch}
              onChange={(e) => setSkuSearch(e.target.value)}
              placeholder="Search SKU…"
              className="w-full pl-9 pr-8 py-2 text-sm rounded-xl border border-gray-200 dark:border-surface-border bg-white dark:bg-surface-elevated text-gray-900 dark:text-text-primary placeholder-gray-400 dark:placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition"
            />
            {skuSearch && (
              <button
                onClick={() => setSkuSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-text-primary"
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
          {skuSearch && (
            <p className="text-xs text-gray-400 dark:text-text-muted mt-1.5">
              {filteredRows.length} of {rows.length} SKUs
            </p>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-950 border-b border-red-800 px-4 md:px-6 py-3">
          <div className="max-w-7xl mx-auto text-sm text-red-300">
            <span className="font-semibold">⚠ Data fetch failed</span>
            <span className="text-red-400"> — {error}</span>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="max-w-7xl mx-auto px-4 md:px-6 py-6 md:py-8">
        {loading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-100 dark:bg-surface-elevated rounded-xl animate-pulse" />
            ))}
          </div>
        ) : rows.length === 0 && !error ? (
          <div className="text-center py-24 flex flex-col items-center gap-3 text-gray-400 dark:text-text-muted">
            <span className="text-4xl">📦</span>
            <p className="text-lg font-medium">No restock data found.</p>
            <p className="text-sm">Run a sync to populate inventory allocations.</p>
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="text-center py-24 flex flex-col items-center gap-3 text-gray-400 dark:text-text-muted">
            <span className="text-4xl">🔍</span>
            <p className="text-lg font-medium">No SKUs match "{skuSearch}"</p>
            <button onClick={() => setSkuSearch('')} className="text-sm text-blue-400 hover:text-blue-300">Clear search</button>
          </div>
        ) : (
          <>
            {/* Desktop */}
            <div className="hidden md:block">
              <RestockTable rows={filteredRows} />
            </div>
            {/* Mobile */}
            <div className="md:hidden space-y-4">
              {filteredRows.map((row) => <SkuCard key={row.sku} row={row} />)}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
