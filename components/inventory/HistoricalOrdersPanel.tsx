'use client';

import { useState, useMemo } from 'react';
import { DailySummary } from '@/lib/data/types';
import { PhysicalDailySummary, PhysicalSkuRecord } from '@/lib/db/queries';
import { formatUSD } from '@/lib/formatters';
import { getFamilySku } from '@/lib/sku';

// ---------------------------------------------------------------------------
// Storefront grouping — group by getFamilySku(internalSku)
// ---------------------------------------------------------------------------

interface GroupedSkuRow {
  internalSku: string;
  isUnmapped: boolean;
  quantitySold: number;
  totalRevenue: number;
  storefrontSkus: { sku: string; qty: number }[];
}

function groupStorefrontSkus(summary: DailySummary, skuMappingLookup: Map<string, string>): GroupedSkuRow[] {
  const map = new Map<string, GroupedSkuRow>();
  for (const row of summary.skus) {
    // row.sku is already the resolved Teapplix SKU (COALESCE in getRecentSummaries SQL).
    // Only consult skuMappingLookup for raw ASIN values — non-ASIN values are already
    // resolved internal SKUs and must NOT be remapped (doing so would merge distinct
    // colour/variant SKUs like AM5234B-10 into AM5234-10 if a stale mapping entry exists).
    const isAsin = /^B0[A-Z0-9]{8}$/.test(row.sku);
    const mappedSku = isAsin ? skuMappingLookup.get(row.sku) : undefined;
    const internalSku = mappedSku ?? (isAsin ? null : row.sku);
    const familyKey = internalSku ? getFamilySku(internalSku) : `__unmapped__${row.sku}`;
    const existing = map.get(familyKey);
    if (existing) {
      existing.quantitySold += row.quantitySold;
      existing.totalRevenue += row.totalRevenue;
      existing.storefrontSkus.push({ sku: row.sku, qty: row.quantitySold });
    } else {
      map.set(familyKey, {
        internalSku: internalSku ? getFamilySku(internalSku) : row.sku,
        isUnmapped: !internalSku,
        quantitySold: row.quantitySold,
        totalRevenue: row.totalRevenue,
        storefrontSkus: [{ sku: row.sku, qty: row.quantitySold }],
      });
    }
  }
  return [...map.values()].sort((a, b) => b.quantitySold - a.quantitySold);
}

// ---------------------------------------------------------------------------
// Physical grouping — group by getFamilySku, no -1 requirement
// ---------------------------------------------------------------------------

interface GroupedPhysicalRow {
  physical_sku: string;  // family string (e.g. "AM5237")
  qty_depleted: number;  // sum of all variants
  storefront_skus: { sku: string; qty: number }[];
  variants: PhysicalSkuRecord[];
}

function groupPhysicalSkus(skus: PhysicalSkuRecord[]): GroupedPhysicalRow[] {
  const familyOrder = new Map<string, number>();
  const families = new Map<string, GroupedPhysicalRow>();

  for (const row of skus) {
    const family = getFamilySku(row.physical_sku);
    if (!families.has(family)) {
      familyOrder.set(family, familyOrder.size);
      families.set(family, {
        physical_sku: family,
        qty_depleted: 0,
        storefront_skus: [],
        variants: [],
      });
    }
    const parent = families.get(family)!;
    parent.variants.push(row);
    parent.qty_depleted += row.qty_depleted;
    parent.storefront_skus = [...parent.storefront_skus, ...row.storefront_skus];
  }

  return [...families.entries()]
    .sort((a, b) => familyOrder.get(a[0])! - familyOrder.get(b[0])!)
    .map(([, row]) => row);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateLabel(dateStr: string): { short: string; full: string } {
  const d = new Date(dateStr + 'T12:00:00');
  const short = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const full = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return { short, full };
}

const thCls = 'px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider';
const tdCls = 'px-4 py-2.5 border-b border-gray-50 dark:border-surface-border';

const tabCls = (active: boolean) =>
  [
    'px-4 py-2 rounded-full text-xs font-semibold transition-colors',
    active
      ? 'bg-accent-primary text-white'
      : 'text-gray-500 dark:text-text-secondary hover:text-gray-700 dark:hover:text-text-primary',
  ].join(' ');

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StorefrontTab({
  summary,
  skuMappingLookup,
}: {
  summary: DailySummary;
  skuMappingLookup: Map<string, string>;
}) {
  const [expandedSku, setExpandedSku] = useState<string | null>(null);
  const grouped = useMemo(() => groupStorefrontSkus(summary, skuMappingLookup), [summary, skuMappingLookup]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 dark:bg-surface-elevated text-left">
            <th className={thCls}>Internal SKU</th>
            <th className={thCls}>Storefront SKU(s)</th>
            <th className={`${thCls} text-right`}>Qty Sold</th>
            <th className={`${thCls} text-right`}>Revenue</th>
          </tr>
        </thead>
        <tbody>
          {grouped.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-10 text-center">
                <div className="flex flex-col items-center gap-2 text-gray-400 dark:text-text-muted">
                  <span className="text-2xl">🛒</span>
                  <span className="text-sm font-medium">No orders for this day</span>
                </div>
              </td>
            </tr>
          ) : (
            grouped.map((row, idx) => {
              const isExpanded = expandedSku === row.internalSku;
              const hasMultiple = row.storefrontSkus.length > 1;
              const isEven = idx % 2 === 0;
              return (
                <>
                  <tr
                    key={row.internalSku}
                    className={[
                      'hover:bg-gray-50 dark:hover:bg-surface-hover transition-colors',
                      isEven ? '' : 'bg-gray-50/50 dark:bg-surface-elevated/30',
                    ].join(' ')}
                  >
                    <td className={`${tdCls} font-semibold text-gray-900 dark:text-text-primary font-mono`}>
                      {row.isUnmapped ? (
                        <span className="text-accent-amber text-xs">unmapped</span>
                      ) : row.internalSku}
                    </td>
                    <td className={`${tdCls} font-mono text-xs text-gray-400 dark:text-text-muted`}>
                      {hasMultiple ? (
                        <button
                          onClick={() => setExpandedSku(isExpanded ? null : row.internalSku)}
                          className="inline-flex items-center gap-1 text-accent-primary hover:text-accent-glow transition-colors"
                        >
                          <span>{row.storefrontSkus.length} variants</span>
                          <span className="text-gray-300">{isExpanded ? '▲' : '▼'}</span>
                        </button>
                      ) : row.storefrontSkus[0].sku}
                    </td>
                    <td className={`${tdCls} text-right text-gray-700 dark:text-text-secondary font-semibold tabular-nums`}>
                      {row.quantitySold.toLocaleString()}
                    </td>
                    <td className={`${tdCls} text-right text-accent-emerald font-semibold tabular-nums`}>
                      {formatUSD(row.totalRevenue)}
                    </td>
                  </tr>
                  {hasMultiple && isExpanded && row.storefrontSkus.map((s) => (
                    <tr key={s.sku} className="bg-indigo-50/40 dark:bg-accent-primary/5">
                      <td className={`${tdCls} pl-8 text-xs text-gray-400 dark:text-text-muted`} />
                      <td className={`${tdCls} font-mono text-xs text-gray-500 dark:text-text-secondary`}>↳ {s.sku}</td>
                      <td className={`${tdCls} text-right text-xs text-gray-500 dark:text-text-muted tabular-nums`}>{s.qty.toLocaleString()}</td>
                      <td className={tdCls} />
                    </tr>
                  ))}
                </>
              );
            })
          )}
        </tbody>
        {grouped.length > 0 && (
          <tfoot>
            <tr className="bg-gray-50 dark:bg-surface-elevated border-t border-gray-200 dark:border-surface-border">
              <td className={`${tdCls} text-xs font-semibold text-gray-500 dark:text-text-muted uppercase`} colSpan={2}>Total</td>
              <td className={`${tdCls} text-right font-bold text-gray-900 dark:text-text-primary tabular-nums`}>
                {grouped.reduce((s, r) => s + r.quantitySold, 0).toLocaleString()}
              </td>
              <td className={`${tdCls} text-right font-bold text-accent-emerald tabular-nums`}>
                {formatUSD(summary.totalRevenue)}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function PhysicalTab({
  physicalSummary,
  skuMappingLookup,
}: {
  physicalSummary: PhysicalDailySummary | null;
  skuMappingLookup: Map<string, string>;
}) {
  const [expandedSku, setExpandedSku] = useState<string | null>(null);
  const rawRows = physicalSummary?.skus ?? [];
  const grouped = useMemo(() => groupPhysicalSkus(rawRows), [rawRows]);
  const totalDepleted = rawRows.reduce((s, r) => s + r.qty_depleted, 0);

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-surface-elevated text-left">
              <th className={thCls}>Physical Inventory SKU</th>
              <th className={thCls}>Storefront SKU(s)</th>
              <th className={`${thCls} text-right`}>Units Depleted</th>
            </tr>
          </thead>
          <tbody>
            {grouped.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-10 text-center">
                  <div className="flex flex-col items-center gap-2 text-gray-400 dark:text-text-muted">
                    <span className="text-2xl">🏭</span>
                    <span className="text-sm font-medium">No physical depletion data for this day</span>
                  </div>
                </td>
              </tr>
            ) : (
              grouped.map((row) => {
                const isExpanded = expandedSku === row.physical_sku;
                const hasVariants = row.variants.length > 0;
                const totalQty = row.qty_depleted; // already summed in groupPhysicalSkus
                const parentStorefrontSkus = hasVariants ? [] : row.storefront_skus;

                return (
                  <>
                    <tr key={row.physical_sku} className="hover:bg-gray-50 dark:hover:bg-surface-hover transition-colors">
                      <td className={`${tdCls} font-semibold text-gray-900 dark:text-text-primary font-mono align-top`}>
                        {hasVariants ? (
                          <button
                            onClick={() => setExpandedSku(isExpanded ? null : row.physical_sku)}
                            className="inline-flex items-center gap-1 hover:text-accent-primary transition-colors"
                          >
                            <span>{row.physical_sku}</span>
                            <span className="text-gray-400 text-xs">{isExpanded ? '▲' : '▼'}</span>
                          </button>
                        ) : row.physical_sku}
                      </td>
                      <td className={`${tdCls} align-top`}>
                        <div className="flex flex-col gap-0.5">
                          {parentStorefrontSkus.map((s, i) => {
                            const mappedSku = skuMappingLookup?.get(s.sku) ?? skuMappingLookup?.get(s.sku.toLowerCase().trim()) ?? s.sku;
                            return (
                              <span key={`${s.sku}-${i}`} className="inline-flex items-center gap-1.5 text-xs">
                                <span className="font-mono text-gray-600 dark:text-text-secondary">{mappedSku}</span>
                                <span className="text-gray-400">·</span>
                                <span className="tabular-nums text-gray-500 dark:text-text-muted">{s.qty} units</span>
                              </span>
                            );
                          })}
                          {hasVariants && !isExpanded && (
                            <span className="text-xs text-gray-400 dark:text-text-muted italic">
                              {row.variants.length} variant{row.variants.length > 1 ? 's' : ''} — click to expand
                            </span>
                          )}
                        </div>
                      </td>
                      <td className={`${tdCls} text-right font-bold text-gray-900 dark:text-text-primary tabular-nums align-top`}>
                        {totalQty.toLocaleString()}
                      </td>
                    </tr>
                    {hasVariants && isExpanded && row.variants.map((variant) => (
                      <tr key={variant.physical_sku} className="bg-indigo-50/40 dark:bg-accent-primary/5">
                        <td className={`${tdCls} pl-8 font-mono text-xs text-gray-500 dark:text-text-muted align-top`}>↳ {variant.physical_sku}</td>
                        <td className={`${tdCls} align-top`}>
                          <div className="flex flex-col gap-0.5">
                            {variant.storefront_skus.map((s, i) => {
                              const mappedSku = skuMappingLookup?.get(s.sku) ?? skuMappingLookup?.get(s.sku.toLowerCase().trim()) ?? s.sku;
                              return (
                                <span key={`${s.sku}-${i}`} className="inline-flex items-center gap-1.5 text-xs">
                                  <span className="font-mono text-gray-500 dark:text-text-muted">{mappedSku}</span>
                                  <span className="text-gray-400">·</span>
                                  <span className="tabular-nums text-gray-400">{s.qty} units</span>
                                </span>
                              );
                            })}
                          </div>
                        </td>
                        <td className={`${tdCls} text-right text-xs text-gray-500 dark:text-text-muted tabular-nums align-top`}>
                          {variant.qty_depleted.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </>
                );
              })
            )}
          </tbody>
          {grouped.length > 0 && (
            <tfoot>
              <tr className="bg-gray-50 dark:bg-surface-elevated border-t border-gray-200 dark:border-surface-border">
                <td className={`${tdCls} text-xs font-semibold text-gray-500 dark:text-text-muted uppercase`} colSpan={2}>Total Units Depleted</td>
                <td className={`${tdCls} text-right font-bold text-gray-900 dark:text-text-primary tabular-nums`}>{totalDepleted.toLocaleString()}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <div className="px-4 py-2 bg-gray-50 dark:bg-surface-elevated border-t border-gray-100 dark:border-surface-border">
        <p className="text-xs text-gray-400 dark:text-text-muted">
          Physical units pulled from warehouse after combo explosion and SKU mapping.
        </p>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface Props {
  summaries: DailySummary[];
  physicalSummaries: PhysicalDailySummary[];
  skuMappingLookup?: Map<string, string>;
  todayStr: string;
}

export default function HistoricalOrdersPanel({
  summaries,
  physicalSummaries,
  skuMappingLookup = new Map(),
  todayStr,
}: Props) {
  // Last 30 days excluding today, newest first
  const recentDays = useMemo(() => {
    return [...summaries]
      .filter((s) => s.date !== todayStr)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 30);
  }, [summaries, todayStr]);

  const physicalByDate = useMemo(() => {
    const map = new Map<string, PhysicalDailySummary>();
    for (const s of physicalSummaries) map.set(s.date, s);
    return map;
  }, [physicalSummaries]);

  const [selectedDate, setSelectedDate] = useState<string>(recentDays[0]?.date ?? '');
  const [activeTab, setActiveTab] = useState<'storefront' | 'physical'>('storefront');

  const selectedSummary = useMemo(
    () => recentDays.find((s) => s.date === selectedDate) ?? null,
    [recentDays, selectedDate]
  );

  const selectedPhysical = useMemo(
    () => physicalByDate.get(selectedDate) ?? null,
    [physicalByDate, selectedDate]
  );

  if (recentDays.length === 0) return null;

  const selectedLabel = selectedDate ? formatDateLabel(selectedDate).full : '';

  return (
    <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100 dark:border-surface-border">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-text-primary">Order History</h3>
        <p className="text-xs text-gray-400 dark:text-text-muted mt-0.5">Last 30 days — pick a date</p>
      </div>

      {/* Date strip */}
      <div className="px-4 py-3 border-b border-gray-100 dark:border-surface-border bg-gray-50 dark:bg-surface-elevated overflow-x-auto">
        <div className="flex gap-1.5 min-w-max">
          {recentDays.map((s) => {
            const { short } = formatDateLabel(s.date);
            const isSelected = s.date === selectedDate;
            const hasOrders = s.orderCount > 0;
            return (
              <button
                key={s.date}
                onClick={() => setSelectedDate(s.date)}
                title={`${s.date} · ${s.orderCount} orders · ${formatUSD(s.totalRevenue)}`}
                className={[
                  'flex flex-col items-center px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors min-w-[48px]',
                  isSelected
                    ? 'bg-accent-primary text-white shadow-sm'
                    : hasOrders
                    ? 'bg-white dark:bg-surface-card text-gray-700 dark:text-text-secondary border border-gray-200 dark:border-surface-border hover:border-accent-primary hover:text-accent-primary'
                    : 'bg-white dark:bg-surface-card text-gray-300 dark:text-text-muted border border-gray-100 dark:border-surface-border opacity-60',
                ].join(' ')}
              >
                <span>{short}</span>
                {hasOrders && (
                  <span className={['tabular-nums text-[10px] mt-0.5', isSelected ? 'text-white/80' : 'text-gray-400 dark:text-text-muted'].join(' ')}>
                    {s.orderCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Summary bar + tab toggle */}
      <div className="px-4 py-2.5 flex items-center justify-between border-b border-gray-100 dark:border-surface-border bg-gray-50/50 dark:bg-surface-elevated/40 flex-wrap gap-2">
        {/* Tabs */}
        <div className="flex items-center gap-1">
          <button onClick={() => setActiveTab('storefront')} className={tabCls(activeTab === 'storefront')}>
            Storefront SKU
          </button>
          <button onClick={() => setActiveTab('physical')} className={tabCls(activeTab === 'physical')}>
            Physical Inventory SKU
          </button>
        </div>

        {/* Day stats */}
        {selectedSummary && (
          <div className="flex items-center gap-4 text-xs">
            <span className="text-gray-500 dark:text-text-muted font-medium">{selectedLabel}</span>
            <span className="text-gray-500 dark:text-text-muted">
              <span className="font-semibold text-gray-700 dark:text-text-primary">{selectedSummary.orderCount}</span> orders
            </span>
            <span className="font-semibold text-accent-emerald">{formatUSD(selectedSummary.totalRevenue)}</span>
          </div>
        )}
      </div>

      {/* Tab content */}
      {activeTab === 'storefront' ? (
        selectedSummary ? (
          <StorefrontTab summary={selectedSummary} skuMappingLookup={skuMappingLookup} />
        ) : (
          <div className="px-4 py-10 text-center text-gray-400 dark:text-text-muted text-sm">No data for this day</div>
        )
      ) : (
        <PhysicalTab physicalSummary={selectedPhysical} skuMappingLookup={skuMappingLookup} />
      )}
    </div>
  );
}
