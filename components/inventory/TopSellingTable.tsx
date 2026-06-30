'use client';

import { useState } from 'react';
import { DailySummary, VolatilityEntry } from '@/lib/data/types';
import { PhysicalDailySummary } from '@/lib/db/queries';
import { getFamilySku } from '@/lib/sku';
import { normalizeSku as resolverNormalizeSku } from '@/lib/sku/resolver';

interface GroupedPhysicalRow {
  physical_sku: string;
  todayQty: number;
  weeklyQty: number;
  rank: number;
  variants: { physical_sku: string; todayQty: number; weeklyQty: number }[];
}

interface StorefrontRow {
  rank: number;
  sku: string;
  todayQty: number;
  weeklyQty: number;
}

function buildStorefrontRows(
  todaySummary: DailySummary | null,
  weeklySummaries: DailySummary[],
  limit: number
): StorefrontRow[] {
  // Collect all storefront SKUs for sibling context (needed by getFamilySku)
  const allStorefrontSkusForFamily = new Set<string>();
  for (const day of weeklySummaries) for (const s of day.skus) allStorefrontSkusForFamily.add(resolverNormalizeSku(s.sku));
  for (const s of todaySummary?.skus ?? []) allStorefrontSkusForFamily.add(resolverNormalizeSku(s.sku));

  // Family key: normalize AM prefix first, then strip pack suffix with sibling check.
  const toSfFamily = (sku: string) => getFamilySku(resolverNormalizeSku(sku), allStorefrontSkusForFamily);

  // Aggregate weekly qty by family
  const weeklyMap = new Map<string, number>();
  for (const day of weeklySummaries) {
    for (const skuRec of day.skus) {
      const family = toSfFamily(skuRec.sku);
      weeklyMap.set(family, (weeklyMap.get(family) ?? 0) + skuRec.quantitySold);
    }
  }

  // Collect all family keys
  const allFamiliesSet = new Set<string>();
  Array.from(weeklyMap.keys()).forEach((k) => allFamiliesSet.add(k));
  (todaySummary?.skus ?? []).forEach((s) => allFamiliesSet.add(toSfFamily(s.sku)));

  // Aggregate today qty by family
  const todayFamilyMap = new Map<string, number>();
  for (const skuRec of todaySummary?.skus ?? []) {
    const family = toSfFamily(skuRec.sku);
    todayFamilyMap.set(family, (todayFamilyMap.get(family) ?? 0) + skuRec.quantitySold);
  }

  const rows: StorefrontRow[] = Array.from(allFamiliesSet).map((family) => ({
    rank: 0,
    sku: family,
    todayQty: todayFamilyMap.get(family) ?? 0,
    weeklyQty: weeklyMap.get(family) ?? 0,
  }));

  const anyTodayQty = rows.some((r) => r.todayQty > 0);
  rows.sort((a, b) => anyTodayQty ? b.todayQty - a.todayQty : b.weeklyQty - a.weeklyQty);
  return rows.slice(0, limit).map((row, i) => ({ ...row, rank: i + 1 }));
}

interface PhysicalRow {
  rank: number;
  physical_sku: string;
  todayQty: number;
  weeklyQty: number;
}

function buildPhysicalRows(
  todayPhysical: PhysicalDailySummary | null,
  weeklyPhysical: PhysicalDailySummary[],
  limit: number
): PhysicalRow[] {
  const weeklyMap = new Map<string, number>();
  for (const day of weeklyPhysical) {
    for (const skuRec of day.skus) {
      weeklyMap.set(skuRec.physical_sku, (weeklyMap.get(skuRec.physical_sku) ?? 0) + skuRec.qty_depleted);
    }
  }
  const allSkusSet = new Set<string>();
  Array.from(weeklyMap.keys()).forEach((k) => allSkusSet.add(k));
  (todayPhysical?.skus ?? []).forEach((s) => allSkusSet.add(s.physical_sku));

  const rows: PhysicalRow[] = Array.from(allSkusSet).map((sku) => {
    const todayRec = todayPhysical?.skus.find((s) => s.physical_sku === sku);
    return { rank: 0, physical_sku: sku, todayQty: todayRec?.qty_depleted ?? 0, weeklyQty: weeklyMap.get(sku) ?? 0 };
  });

  const anyTodayQty = rows.some((r) => r.todayQty > 0);
  rows.sort((a, b) => anyTodayQty ? b.todayQty - a.todayQty : b.weeklyQty - a.weeklyQty);
  return rows.slice(0, limit).map((row, i) => ({ ...row, rank: i + 1 }));
}

function groupPhysicalRows(rows: PhysicalRow[], inventoryMap: Map<string, number>): GroupedPhysicalRow[] {
  // Build normalized SKU set for sibling-aware family resolution.
  // Include ALL inventory SKUs (not just depleted ones) so base-unit SKUs like
  // 5233B-1 are present as siblings even when they had zero depletion this week.
  // Without this, 5233B-10 would fail the sibling check and show as its own row.
  const allPhysNormalized = new Set(rows.map((r) => resolverNormalizeSku(r.physical_sku)));
  for (const k of inventoryMap.keys()) allPhysNormalized.add(resolverNormalizeSku(k));
  const toPhysFamily = (sku: string) => getFamilySku(resolverNormalizeSku(sku), allPhysNormalized);

  // family string → order index (first-seen)
  const familyOrder = new Map<string, number>();
  // family string → grouped row
  const families = new Map<string, GroupedPhysicalRow>();

  for (const row of rows) {
    const family = toPhysFamily(row.physical_sku);
    if (!families.has(family)) {
      familyOrder.set(family, familyOrder.size);
      families.set(family, {
        physical_sku: family,
        todayQty: 0,
        weeklyQty: 0,
        rank: 0,
        variants: [],
      });
    }
    const parent = families.get(family)!;
    parent.todayQty += row.todayQty;
    parent.weeklyQty += row.weeklyQty;
    parent.variants.push({ physical_sku: row.physical_sku, todayQty: row.todayQty, weeklyQty: row.weeklyQty });
  }

  return [...families.entries()]
    .sort((a, b) => familyOrder.get(a[0])! - familyOrder.get(b[0])!)
    .map(([, row], i) => ({ ...row, rank: i + 1 }));
}

export function buildTopSellingRows(todaySummary: DailySummary | null, weeklySummaries: DailySummary[], limit = 20) {
  return buildStorefrontRows(todaySummary, weeklySummaries, limit);
}

/**
 * Normalize a raw inventory SKU to a family key, matching the same logic
 * used by getRestockPlan's toFamilyKey:
 *   1. resolverNormalizeSku strips AM/1AM prefix and other artifacts.
 *   2. getFamilySku then strips pack suffixes using sibling context.
 *
 * This ensures AM5234-1 and 5234-1 resolve to the same family key "5234".
 */
function toInventoryFamilyKey(sku: string, normalizedSkuSet: Set<string>): string {
  const normalized = resolverNormalizeSku(sku);
  return getFamilySku(normalized, normalizedSkuSet);
}

/**
 * Aggregate inventoryMap stock at the family level.
 * Returns a new Map keyed by family string → sum of all variant stock values.
 *
 * Uses resolverNormalizeSku before getFamilySku so AM-prefixed and non-AM
 * SKUs (e.g. AM5234-1 and 5234-1) merge into the same family bucket.
 * This matches the family-merge logic in getRestockPlan.
 */
function buildFamilyInventoryMap(
  inventoryMap: Map<string, number>,
  weeklyPhysical: PhysicalDailySummary[]
): Map<string, number> {
  // Build normalized SKU set from all inventory keys + depletion-seen SKUs.
  // Normalization strips AM prefix so sibling detection works cross-channel.
  const normalizedSkuSet = new Set<string>();
  for (const k of inventoryMap.keys()) normalizedSkuSet.add(resolverNormalizeSku(k));
  for (const day of weeklyPhysical) {
    for (const r of day.skus) normalizedSkuSet.add(resolverNormalizeSku(r.physical_sku));
  }

  // Use MAX per family, not SUM.
  // AM5237-1 and 5237-1 track the same physical bin — summing them double-counts.
  // Restock planner uses the highest-stock member as the stock truth; match that here.
  const familyMap = new Map<string, number>();
  for (const [sku, qty] of inventoryMap) {
    const family = toInventoryFamilyKey(sku, normalizedSkuSet);
    familyMap.set(family, Math.max(familyMap.get(family) ?? 0, qty));
  }
  return familyMap;
}

function rankLabel(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return String(rank);
}

function TrendBadge({ trend }: { trend: 'up' | 'down' | 'stable' }) {
  if (trend === 'up') return <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-900 text-emerald-300">↑</span>;
  if (trend === 'down') return <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs font-semibold bg-red-900 text-red-300">↓</span>;
  return <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs font-medium bg-surface-elevated text-text-muted">→</span>;
}

interface TopSellingTableProps {
  todaySummary: DailySummary | null;
  weeklySummaries: DailySummary[];
  todayPhysicalSummary: PhysicalDailySummary | null;
  weeklyPhysicalSummaries: PhysicalDailySummary[];
  inventoryMap?: Map<string, number>;
  skuMappingLookup?: Map<string, string>;
  volatilityEntries?: VolatilityEntry[];
  limit?: number;
}

const tabCls = (active: boolean) =>
  [
    'px-4 py-2 rounded-full text-xs font-semibold transition-colors',
    active
      ? 'bg-accent-primary text-white'
      : 'text-gray-500 dark:text-text-secondary hover:text-gray-700 dark:hover:text-text-primary',
  ].join(' ');

export default function TopSellingTable({
  todaySummary,
  weeklySummaries,
  todayPhysicalSummary,
  weeklyPhysicalSummaries,
  inventoryMap = new Map(),
  skuMappingLookup = new Map(),
  volatilityEntries = [],
  limit = 20,
}: TopSellingTableProps) {
  const [activeTab, setActiveTab] = useState<'storefront' | 'physical'>('storefront');
  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  const storefrontRows = buildStorefrontRows(todaySummary, weeklySummaries, limit);
  const physicalRows = groupPhysicalRows(buildPhysicalRows(todayPhysicalSummary, weeklyPhysicalSummaries, limit), inventoryMap);

  // Family-level stock map: keyed by family string, value = sum of all variant stock
  const familyInventoryMap = buildFamilyInventoryMap(inventoryMap, weeklyPhysicalSummaries);

  // Storefront family stock: resolve raw storefront SKU → internal → family
  // Collect all storefront SKUs for sibling check
  const allStorefrontSkus = new Set<string>();
  for (const day of weeklySummaries) for (const r of day.skus) allStorefrontSkus.add(r.sku);
  if (todaySummary) for (const r of todaySummary.skus) allStorefrontSkus.add(r.sku);

  // Build storefront-family → stock map using skuMappingLookup + inventoryMap.
  // Keys computed with toInventoryFamilyKey(rawSku, normalizedInvSkuSet) — same
  // normalization (AM-strip) used by buildFamilyInventoryMap and getRestockPlan,
  // so storefront families resolve to the same keys as physical families.
  const normalizedInvSkuSet = new Set<string>();
  for (const k of inventoryMap.keys()) normalizedInvSkuSet.add(resolverNormalizeSku(k));
  for (const day of weeklySummaries) for (const r of day.skus) normalizedInvSkuSet.add(resolverNormalizeSku(r.sku));
  if (todaySummary) for (const r of todaySummary.skus) normalizedInvSkuSet.add(resolverNormalizeSku(r.sku));

  const storefrontFamilyInventoryMap = new Map<string, number>();
  for (const [rawSku, physicalSku] of skuMappingLookup) {
    const family = toInventoryFamilyKey(rawSku, normalizedInvSkuSet);
    const qty = inventoryMap.get(physicalSku);
    if (qty !== undefined) {
      // Use max: multiple storefront SKUs can map to the same physical SKU
      // (e.g. AM5237-1 and AM5237-10 both map to 5237-1). Summing would
      // multiply the stock count. Take the highest value seen per family.
      storefrontFamilyInventoryMap.set(family, Math.max(storefrontFamilyInventoryMap.get(family) ?? 0, qty));
    }
  }
  // Also add direct hits (storefront SKU = physical SKU, no mapping entry)
  for (const rawSku of allStorefrontSkus) {
    const family = toInventoryFamilyKey(rawSku, normalizedInvSkuSet);
    const qty = inventoryMap.get(rawSku);
    if (qty !== undefined && !storefrontFamilyInventoryMap.has(family)) {
      storefrontFamilyInventoryMap.set(family, qty);
    }
  }

  const volatilityMap = new Map(volatilityEntries.map((e) => [e.sku, e]));

  const thCls = 'px-4 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider';
  const tdCls = 'px-4 py-3 border-b border-gray-50 dark:border-surface-border';

  return (
    <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-surface-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-text-primary">Top Selling Items</h3>
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-surface-elevated rounded-full p-1">
          <button onClick={() => setActiveTab('storefront')} className={tabCls(activeTab === 'storefront')}>
            Storefront SKU
          </button>
          <button onClick={() => setActiveTab('physical')} className={tabCls(activeTab === 'physical')}>
            Physical Inventory SKU
          </button>
        </div>
      </div>

      {/* Storefront tab */}
      {activeTab === 'storefront' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-surface-elevated text-left">
                <th className={`${thCls} w-12`}>#</th>
                <th className={thCls}>Storefront SKU</th>
                <th className={`${thCls} text-right`}>Qty Today</th>
                <th className={`${thCls} text-right`}>Qty This Week</th>
                <th className={`${thCls} text-right`}>Available Stock</th>
                <th className={`${thCls} text-center`}>Trend</th>
              </tr>
            </thead>
            <tbody>
              {storefrontRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <div className="flex flex-col items-center gap-2 text-gray-400 dark:text-text-muted">
                      <span className="text-2xl">📦</span>
                      <span className="text-sm font-medium">No orders today</span>
                    </div>
                  </td>
                </tr>
              ) : (
                storefrontRows.map((row) => {
                  // row.sku is already the family string (getFamilySku applied in buildStorefrontRows)
                  // Look up family-level aggregated stock
                  const qtyAvailable = storefrontFamilyInventoryMap.get(row.sku)
                    ?? familyInventoryMap.get(row.sku);
                  const velocity = row.weeklyQty / 7;
                  const daysOfSupply = qtyAvailable !== undefined && velocity > 0 ? qtyAvailable / velocity : null;
                  const lowStock = daysOfSupply !== null && daysOfSupply < 10;
                  const vol = volatilityMap.get(row.sku);

                  return (
                    <tr key={row.sku} className="hover:bg-gray-50 dark:hover:bg-surface-hover transition-colors">
                      <td className={`${tdCls} text-gray-400 dark:text-text-muted font-mono text-center`}>
                        {rankLabel(row.rank)}
                      </td>
                      <td className={`${tdCls} font-medium text-gray-900 dark:text-text-primary font-mono`}>
                        <span className="inline-flex items-center gap-1.5">
                          {row.sku}
                          {lowStock && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-semibold bg-amber-900 text-amber-300">
                              ⚠ REORDER
                            </span>
                          )}
                        </span>
                      </td>
                      <td className={`${tdCls} text-right text-gray-700 dark:text-text-secondary tabular-nums`}>{row.todayQty.toLocaleString()}</td>
                      <td className={`${tdCls} text-right text-gray-700 dark:text-text-secondary tabular-nums`}>{row.weeklyQty.toLocaleString()}</td>
                      <td className={`${tdCls} text-right text-gray-500 dark:text-text-muted tabular-nums`}>
                        {qtyAvailable !== undefined ? (
                          <div className="flex flex-col items-end gap-1">
                            <span>{qtyAvailable.toLocaleString()} units</span>
                            {daysOfSupply !== null && (
                              <div className="w-16 h-1 bg-gray-100 dark:bg-surface-elevated rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${daysOfSupply <= 7 ? 'bg-accent-red' : daysOfSupply <= 14 ? 'bg-accent-amber' : 'bg-accent-emerald'}`}
                                  style={{ width: `${Math.min((daysOfSupply / 30) * 100, 100)}%` }}
                                />
                              </div>
                            )}
                          </div>
                        ) : '—'}
                      </td>
                      <td className={`${tdCls} text-center`}>
                        {vol ? <TrendBadge trend={vol.trend} /> : <span className="text-gray-300 dark:text-text-muted text-xs">—</span>}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Physical tab */}
      {activeTab === 'physical' && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-surface-elevated text-left">
                  <th className={`${thCls} w-12`}>#</th>
                  <th className={thCls}>Physical Inventory SKU</th>
                  <th className={thCls}>Storefront SKU(s)</th>
                  <th className={`${thCls} text-right`}>Depleted Today</th>
                  <th className={`${thCls} text-right`}>Depleted This Week</th>
                  <th className={`${thCls} text-right`}>Available Stock</th>
                </tr>
              </thead>
              <tbody>
                {physicalRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center">
                      <div className="flex flex-col items-center gap-2 text-gray-400 dark:text-text-muted">
                        <span className="text-2xl">🏭</span>
                        <span className="text-sm font-medium">No physical depletion data</span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  physicalRows.map((row) => {
                    const isExpanded = expandedSku === row.physical_sku;
                    const hasVariants = row.variants.length > 0;
                    // row.todayQty and row.weeklyQty are already family sums from groupPhysicalRows
                    const totalTodayQty = row.todayQty;
                    const totalWeeklyQty = row.weeklyQty;
                    // Use family-level aggregated stock (sum across all variants)
                    const qtyAvailable = familyInventoryMap.get(row.physical_sku);
                    const velocity = totalWeeklyQty / 7;
                    const daysOfSupply = qtyAvailable !== undefined && velocity > 0 ? qtyAvailable / velocity : null;
                    const lowStock = daysOfSupply !== null && daysOfSupply < 10;
                    // Aggregate storefront SKUs from all variant rows in today's physical summary
                    const todayStorefrontSkus = hasVariants
                      ? row.variants.flatMap((v) =>
                          todayPhysicalSummary?.skus.find((s) => s.physical_sku === v.physical_sku)?.storefront_skus ?? []
                        )
                      : todayPhysicalSummary?.skus.find((s) => s.physical_sku === row.physical_sku)?.storefront_skus ?? [];

                    return (
                      <>
                        <tr key={row.physical_sku} className="hover:bg-gray-50 dark:hover:bg-surface-hover transition-colors">
                          <td className={`${tdCls} text-gray-400 dark:text-text-muted font-mono text-center align-top`}>
                            {rankLabel(row.rank)}
                          </td>
                          <td className={`${tdCls} font-semibold text-gray-900 dark:text-text-primary font-mono align-top`}>
                            <span className="inline-flex items-center gap-1.5">
                              {hasVariants ? (
                                <button
                                  onClick={() => setExpandedSku(isExpanded ? null : row.physical_sku)}
                                  className="inline-flex items-center gap-1 hover:text-accent-primary transition-colors"
                                >
                                  <span>{row.physical_sku}</span>
                                  <span className="text-gray-400 text-xs">{isExpanded ? '▲' : '▼'}</span>
                                </button>
                              ) : row.physical_sku}
                              {lowStock && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-semibold bg-amber-900 text-amber-300">
                                  ⚠ REORDER
                                </span>
                              )}
                            </span>
                          </td>
                          <td className={`${tdCls} align-top`}>
                            {todayStorefrontSkus.length > 0 ? (
                              <div className="flex flex-col gap-0.5">
                                {todayStorefrontSkus.map((s) => {
                                  const mappedSku = skuMappingLookup.get(s.sku) ?? skuMappingLookup.get(s.sku.toLowerCase().trim()) ?? s.sku;
                                  return (
                                    <span key={s.sku} className="inline-flex items-center gap-1.5 text-xs">
                                      <span className="font-mono text-gray-600 dark:text-text-secondary">{mappedSku}</span>
                                      <span className="text-gray-400">·</span>
                                      <span className="tabular-nums text-gray-500 dark:text-text-muted">{s.qty} units</span>
                                    </span>
                                  );
                                })}
                              </div>
                            ) : <span className="text-xs text-gray-400 dark:text-text-muted">—</span>}
                          </td>
                          <td className={`${tdCls} text-right text-gray-700 dark:text-text-secondary tabular-nums align-top`}>{totalTodayQty.toLocaleString()}</td>
                          <td className={`${tdCls} text-right text-gray-700 dark:text-text-secondary tabular-nums align-top`}>{totalWeeklyQty.toLocaleString()}</td>
                          <td className={`${tdCls} text-right text-gray-500 dark:text-text-muted tabular-nums align-top`}>
                            {qtyAvailable !== undefined ? qtyAvailable.toLocaleString() : '—'}
                          </td>
                        </tr>
                        {hasVariants && isExpanded && row.variants.map((variant) => {
                          const variantStorefrontSkus = todayPhysicalSummary?.skus.find((s) => s.physical_sku === variant.physical_sku)?.storefront_skus ?? [];
                          return (
                            <tr key={variant.physical_sku} className="bg-indigo-50/40 dark:bg-accent-primary/5">
                              <td className="px-4 py-2 border-b border-gray-50 dark:border-surface-border" />
                              <td className="px-4 py-2 pl-8 font-mono text-xs text-gray-500 dark:text-text-muted border-b border-gray-50 dark:border-surface-border align-top">
                                ↳ {variant.physical_sku}
                              </td>
                              <td className="px-4 py-2 border-b border-gray-50 dark:border-surface-border align-top">
                                {variantStorefrontSkus.length > 0 ? (
                                  <div className="flex flex-col gap-0.5">
                                    {variantStorefrontSkus.map((s) => {
                                      const mappedSku = skuMappingLookup.get(s.sku) ?? skuMappingLookup.get(s.sku.toLowerCase().trim()) ?? s.sku;
                                      return (
                                        <span key={s.sku} className="inline-flex items-center gap-1.5 text-xs">
                                          <span className="font-mono text-gray-500 dark:text-text-muted">{mappedSku}</span>
                                          <span className="text-gray-400">·</span>
                                          <span className="tabular-nums text-gray-400">{s.qty} units</span>
                                        </span>
                                      );
                                    })}
                                  </div>
                                ) : <span className="text-xs text-gray-400">—</span>}
                              </td>
                              <td className="px-4 py-2 text-right text-xs text-gray-500 dark:text-text-muted tabular-nums border-b border-gray-50 dark:border-surface-border align-top">{variant.todayQty.toLocaleString()}</td>
                              <td className="px-4 py-2 text-right text-xs text-gray-500 dark:text-text-muted tabular-nums border-b border-gray-50 dark:border-surface-border align-top">{variant.weeklyQty.toLocaleString()}</td>
                              <td className="px-4 py-2 text-right text-xs text-gray-400 tabular-nums border-b border-gray-50 dark:border-surface-border align-top">—</td>
                            </tr>
                          );
                        })}
                      </>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2 bg-gray-50 dark:bg-surface-elevated border-t border-gray-100 dark:border-surface-border">
            <p className="text-xs text-gray-400 dark:text-text-muted">
              Physical units pulled from warehouse after combo explosion and SKU mapping.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
