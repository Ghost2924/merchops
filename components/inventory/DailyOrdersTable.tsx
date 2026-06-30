'use client';

import { useState, useEffect } from 'react';
import { DailySummary } from '@/lib/data/types';
import { PhysicalDailySummary, PhysicalSkuRecord } from '@/lib/db/queries';
import { formatUSD } from '@/lib/formatters';
import { normalizeSku, parsePack } from '@/lib/sku/resolver';

/** Family key: parsePack(normalizeSku(sku)).base */
function familyKey(sku: string): string {
  return parsePack(normalizeSku(sku)).base;
}
import { Printer, X, Loader2 } from 'lucide-react';

interface GroupedPhysicalRow {
  physical_sku: string;  // family label (e.g. "AM5237")
  qty_depleted: number;  // sum of all variants in this family
  storefront_skus: { sku: string; qty: number }[];
  variants: PhysicalSkuRecord[];  // the individual variant rows nested under the family
}

/**
 * Group physical SKUs by family (getFamilySku).
 *
 * Parent row label = family string (e.g. "AM5237"), NOT an existing variant.
 * Every SKU whose getFamilySku() equals the family is nested as a variant.
 * Family total = sum of all nested rows' qty_depleted.
 * No -1 requirement. No data-presence requirement.
 */
function groupPhysicalSkus(skus: PhysicalSkuRecord[]): GroupedPhysicalRow[] {
  // family string → order index (first-seen order)
  const familyOrder = new Map<string, number>();
  // family string → grouped row
  const families = new Map<string, GroupedPhysicalRow>();

  for (const row of skus) {
    const family = familyKey(row.physical_sku);
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
    parent.storefront_skus = [
      ...parent.storefront_skus,
      ...row.storefront_skus,
    ];
  }

  // Sort by first-seen order
  return [...families.entries()]
    .sort((a, b) => familyOrder.get(a[0])! - familyOrder.get(b[0])!)
    .map(([, row]) => row);
}

interface DailyOrdersTableProps {
  todaySummary: DailySummary | null;
  todayPhysicalSummary: PhysicalDailySummary | null;
  skuMappingLookup?: Map<string, string>;
}

interface GroupedSkuRow {
  internalSku: string;
  isUnmapped: boolean;
  quantitySold: number;
  totalOrders: number;
  totalRevenue: number;
  storefrontSkus: { sku: string; qty: number; orders: number }[];
}

/** Orders for a storefront SKU = qty / pack size parsed from SKU */
function skuOrders(sku: string, qty: number): number {
  const { qty: pack } = parsePack(normalizeSku(sku));
  return pack > 1 ? Math.round(qty / pack) : qty;
}

const thCls = 'px-4 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider';
const tdCls = 'px-4 py-3 border-b border-gray-50 dark:border-surface-border';

function StorefrontTab({
  todaySummary,
  skuMappingLookup,
}: {
  todaySummary: DailySummary | null;
  skuMappingLookup: Map<string, string>;
}) {
  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  const grouped: GroupedSkuRow[] = (() => {
    if (!todaySummary) return [];
    // Group by getFamilySku(internalSku) so variants collapse under one family row.
    // The family string itself becomes the parent label (e.g. "AM5237", never "AM5237-1").
    //
    // NOTE: row.sku here is already the resolved Teapplix SKU (from COALESCE in
    // getRecentSummaries SQL). We only consult skuMappingLookup for raw ASIN rows
    // (where resolved_teapplix_sku was NULL and raw_storefront_sku fell through).
    // We must NOT re-map already-resolved internal SKUs — doing so would cause
    // colour/variant SKUs like AM5234B-10 to double-map onto AM5234-10 if a
    // stale sku_mappings entry happens to use AM5234B-10 as its source_sku.
    const map = new Map<string, GroupedSkuRow>();
    for (const row of todaySummary.skus) {
      const isAsin = /^B0[A-Z0-9]{8}$/.test(row.sku);
      // Only look up ASINs — they may still be raw storefront keys if resolved_teapplix_sku was null.
      // Non-ASIN values are already resolved internal SKUs; do not remap them.
      const mappedSku = isAsin ? skuMappingLookup.get(row.sku) : undefined;
      const internalSku = mappedSku ?? (isAsin ? null : row.sku);
      const familyK = internalSku ? familyKey(internalSku) : `__unmapped__${row.sku}`;
      const existing = map.get(familyK);
      const orders = skuOrders(row.sku, row.quantitySold);
      if (existing) {
        existing.quantitySold += row.quantitySold;
        existing.totalOrders  += orders;
        existing.totalRevenue += row.totalRevenue;
        existing.storefrontSkus.push({ sku: row.sku, qty: row.quantitySold, orders });
      } else {
        map.set(familyK, {
          // Display the family key as the canonical label
          internalSku: internalSku ? familyKey(internalSku) : row.sku,
          isUnmapped: !internalSku,
          quantitySold: row.quantitySold,
          totalOrders: orders,
          totalRevenue: row.totalRevenue,
          storefrontSkus: [{ sku: row.sku, qty: row.quantitySold, orders }],
        });
      }
    }
    return [...map.values()].sort((a, b) => b.quantitySold - a.quantitySold);
  })();

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-surface-elevated text-left">
              <th className={thCls}>Internal SKU</th>
              <th className={thCls}>Storefront SKU(s)</th>
              <th className={`${thCls} text-right`}>Qty Sold</th>
              <th className={`${thCls} text-right`}>Orders</th>
              <th className={`${thCls} text-right`}>Revenue</th>
            </tr>
          </thead>
          <tbody>
            {grouped.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center">
                  <div className="flex flex-col items-center gap-2 text-gray-400 dark:text-text-muted">
                    <span className="text-2xl">🛒</span>
                    <span className="text-sm font-medium">No orders today</span>
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
                      <td className={`${tdCls} text-right text-gray-500 dark:text-text-muted tabular-nums`}>
                        {row.totalOrders.toLocaleString()}
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
                        <td className={`${tdCls} text-right text-xs text-gray-400 dark:text-text-muted tabular-nums`}>{s.orders.toLocaleString()}</td>
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
                <td className={`${tdCls} text-right font-bold text-gray-700 dark:text-text-secondary tabular-nums`}>
                  {grouped.reduce((s, r) => s + r.totalOrders, 0).toLocaleString()}
                </td>
                <td className={`${tdCls} text-right font-bold text-accent-emerald tabular-nums`}>
                  {formatUSD(todaySummary!.totalRevenue)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </>
  );
}

function PhysicalTab({
  todayPhysicalSummary,
  skuMappingLookup,
}: {
  todayPhysicalSummary: PhysicalDailySummary | null;
  skuMappingLookup?: Map<string, string>;
}) {
  const [expandedSku, setExpandedSku] = useState<string | null>(null);
  const rawRows = todayPhysicalSummary?.skus ?? [];
  const grouped = groupPhysicalSkus(rawRows);
  const totalDepleted = rawRows.reduce((s, r) => s + r.qty_depleted, 0);

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-surface-elevated text-left">
              <th className={thCls}>Physical Inventory SKU</th>
              <th className={`${thCls} text-right`}>Units Depleted</th>
            </tr>
          </thead>
          <tbody>
            {grouped.length === 0 ? (
              <tr>
                <td colSpan={2} className="px-4 py-12 text-center">
                  <div className="flex flex-col items-center gap-2 text-gray-400 dark:text-text-muted">
                    <span className="text-2xl">🏭</span>
                    <span className="text-sm font-medium">No physical depletion data today</span>
                  </div>
                </td>
              </tr>
            ) : (
              grouped.map((row) => {
                const isExpanded = expandedSku === row.physical_sku;
                const hasVariants = row.variants.length > 0;
                const totalQty = row.qty_depleted; // already summed across all variants in groupPhysicalSkus

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
                      <td className={`${tdCls} text-right font-bold text-gray-900 dark:text-text-primary tabular-nums align-top`}>
                        {totalQty.toLocaleString()}
                      </td>
                    </tr>
                    {hasVariants && isExpanded && row.variants.map((variant) => (
                      <tr key={variant.physical_sku} className="bg-indigo-50/40 dark:bg-accent-primary/5">
                        <td className={`${tdCls} pl-8 font-mono text-xs text-gray-500 dark:text-text-muted align-top`}>↳ {variant.physical_sku}</td>
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
                <td className={`${tdCls} text-xs font-semibold text-gray-500 dark:text-text-muted uppercase`}>Total Units Depleted</td>
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

export default function DailyOrdersTable({
  todaySummary,
  todayPhysicalSummary,
  skuMappingLookup = new Map(),
}: DailyOrdersTableProps) {
  const [activeTab, setActiveTab] = useState<'storefront' | 'physical'>('storefront');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickList, setPickList] = useState<{ sku: string; title: string; qty: number }[]>([]);
  const [pickDays, setPickDays] = useState(1);
  const [pickDateRange, setPickDateRange] = useState<{ start: string; end: string } | null>(null);

  const date = todaySummary?.date ?? todayPhysicalSummary?.date ?? null;
  const orderCount = todaySummary?.orderCount ?? 0;

  const fetchPickList = async (days = pickDays) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/pick-list?days=${days}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Failed to fetch pick list');
      }
      setPickList(data.data);
      setPickDateRange(
        data.startDate && data.date
          ? { start: data.startDate, end: data.date }
          : null
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isModalOpen) {
      fetchPickList(pickDays);
    }
  }, [isModalOpen]);

  const handleDaysChange = (d: number) => {
    setPickDays(d);
    fetchPickList(d);
  };

  const tabCls = (active: boolean) =>
    [
      'px-4 py-2 rounded-full text-xs font-semibold transition-colors',
      active
        ? 'bg-accent-primary text-white'
        : 'text-gray-500 dark:text-text-secondary hover:text-gray-700 dark:hover:text-text-primary',
    ].join(' ');

  return (
    <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-surface-border flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-text-primary">Today&apos;s Orders</h3>
          <p className="text-xs text-gray-400 dark:text-text-muted mt-0.5">
            {date ? `${orderCount} orders · ${date}` : 'No data yet for today'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/90 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors font-sans"
            id="print-pick-list-btn"
          >
            <Printer size={14} />
            <span>Print Pick List</span>
          </button>
          {todaySummary && (
            <span className="text-sm font-semibold text-accent-emerald">
              {formatUSD(todaySummary.totalRevenue)}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 px-4 py-2 bg-gray-50 dark:bg-surface-elevated border-b border-gray-100 dark:border-surface-border">
        <button onClick={() => setActiveTab('storefront')} className={tabCls(activeTab === 'storefront')}>
          Storefront SKU
        </button>
        <button onClick={() => setActiveTab('physical')} className={tabCls(activeTab === 'physical')}>
          Physical Inventory SKU
        </button>
      </div>

      {activeTab === 'storefront' ? (
        <StorefrontTab todaySummary={todaySummary} skuMappingLookup={skuMappingLookup} />
      ) : (
        <PhysicalTab todayPhysicalSummary={todayPhysicalSummary} skuMappingLookup={skuMappingLookup} />
      )}

      {/* Pick List Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fadeIn">
          <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col overflow-hidden">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-100 dark:border-surface-border flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-text-primary">Pick List</h3>
                <p className="text-xs text-gray-400 dark:text-text-muted mt-0.5">
                  {pickDateRange && pickDateRange.start !== pickDateRange.end
                    ? `${pickDateRange.start} → ${pickDateRange.end}`
                    : pickDateRange
                    ? pickDateRange.end
                    : 'Consolidated physical inventory required'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {/* Day range selector */}
                <div className="flex items-center gap-1 bg-gray-100 dark:bg-surface-elevated rounded-lg p-1">
                  {[1, 2, 3, 4, 5].map((d) => (
                    <button
                      key={d}
                      onClick={() => handleDaysChange(d)}
                      disabled={loading}
                      className={[
                        'px-2.5 py-1 rounded-md text-xs font-semibold transition-colors disabled:opacity-50',
                        pickDays === d
                          ? 'bg-accent-primary text-white shadow-sm'
                          : 'text-gray-500 dark:text-text-secondary hover:text-gray-700 dark:hover:text-text-primary hover:bg-white dark:hover:bg-surface-card',
                      ].join(' ')}
                    >
                      {d}d
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setIsModalOpen(false)}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-text-primary transition-colors p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-surface-hover"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Modal Body / Print Area */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {loading && (
                <div className="py-20 flex flex-col items-center justify-center gap-3">
                  <Loader2 className="w-8 h-8 text-accent-primary animate-spin" />
                  <span className="text-sm text-gray-500 dark:text-text-secondary">Generating pick list...</span>
                </div>
              )}

              {error && (
                <div className="p-4 bg-red-50 dark:bg-red-950/30 border border-red-100 dark:border-red-900/50 rounded-xl text-sm text-red-600 dark:text-red-400 font-sans">
                  <p className="font-semibold">Failed to load pick list</p>
                  <p className="text-xs mt-1 text-red-500">{error}</p>
                </div>
              )}

              {!loading && !error && (
                <div className="print-area">
                  {/* Clean header visible ONLY when printing */}
                  <div className="hidden print:block mb-6 border-b pb-4">
                    <h1 className="text-2xl font-bold text-black font-sans">Teapplix Fulfillment Pick List</h1>
                    <p className="text-sm text-gray-600 mt-1 font-sans">
                      {pickDateRange && pickDateRange.start !== pickDateRange.end
                        ? `Date range: ${pickDateRange.start} → ${pickDateRange.end}`
                        : `Date: ${pickDateRange?.end || date || new Date().toISOString().slice(0, 10)}`}
                      {' '}&middot; Generated: {new Date().toLocaleTimeString()}
                    </p>
                  </div>

                  {pickList.length === 0 ? (
                    <div className="py-12 text-center text-gray-500 dark:text-text-secondary font-sans">
                      No items to pick for today.
                    </div>
                  ) : (
                    <div>
                      <table className="w-full text-sm text-left">
                        <thead>
                          <tr className="bg-gray-50 dark:bg-surface-elevated text-gray-500 dark:text-text-muted border-b border-gray-100 dark:border-surface-border">
                            <th className="px-4 py-3 font-semibold text-xs uppercase tracking-wider font-sans">Physical SKU</th>
                            <th className="px-4 py-3 font-semibold text-xs uppercase tracking-wider font-sans">Product Name</th>
                            <th className="px-4 py-3 font-semibold text-xs uppercase tracking-wider text-right font-sans">Qty to Pick</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pickList.map((item, idx) => (
                            <tr
                              key={item.sku}
                              className={`border-b border-gray-100 dark:border-surface-border text-gray-800 dark:text-text-secondary ${
                                idx % 2 === 0 ? '' : 'bg-gray-50/30 dark:bg-surface-elevated/10'
                              }`}
                            >
                              <td className="px-4 py-3 font-mono font-bold text-gray-900 dark:text-text-primary text-xs">
                                {item.sku}
                              </td>
                              <td className="px-4 py-3 text-xs font-sans">
                                {item.title}
                              </td>
                              <td className="px-4 py-3 font-bold text-right text-gray-900 dark:text-text-primary tabular-nums">
                                {item.qty}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-gray-100 dark:border-surface-border flex items-center justify-end gap-3 bg-gray-50 dark:bg-surface-elevated/40">
              <button
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-2 border border-gray-200 dark:border-surface-border text-gray-700 dark:text-text-secondary hover:bg-gray-100 dark:hover:bg-surface-hover text-xs font-semibold rounded-lg transition-colors font-sans"
              >
                Close
              </button>
              <button
                onClick={() => window.print()}
                disabled={loading || !!error || pickList.length === 0}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-accent-primary hover:bg-accent-primary/90 disabled:opacity-50 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors font-sans"
              >
                <Printer size={14} />
                <span>Print Pick List</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
