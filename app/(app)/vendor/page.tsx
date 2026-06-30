'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, useMemo, useCallback } from 'react';
import KpiCard from '@/components/kpi/KpiCard';
import { formatUSD } from '@/lib/formatters';
import { DollarSign, TrendingUp, Tag, AlertTriangle, ChevronDown, ChevronRight, Zap, ShoppingBag, BarChart2 } from 'lucide-react';
import { normalizeSku, parsePack } from '@/lib/sku/resolver';

/**
 * Family key for grouping ASINs by base product line.
 *
 * Steps:
 *  1. normalizeSku (strip quotes, AM prefix, -LA suffix, etc.)
 *  2. Strip trailing all-caps qualifier segments like -HEAVY, -HEAVY-HEAVY
 *     (appended by the shadow-mapping seeder as weight/grade labels).
 *  3. parsePack → strip numeric/word pack suffix (e.g. -1, -2, -four).
 *
 * Examples:
 *   "5234-1-HEAVY-HEAVY"  → "5234"
 *   "5234-2-HEAVY-HEAVY"  → "5234"
 *   "5003MCC-4"           → "5003MCC"
 *   "AM5237-3"            → "5237"
 */
function familyKey(sku: string): string {
  let s = normalizeSku(sku);
  // Strip trailing all-caps word segments (e.g. -HEAVY, -HEAVY-HEAVY, -MEDIUM)
  s = s.replace(/((?:-[A-Z]{2,})+)$/, '');
  return parsePack(s).base;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AsinRow {
  asin: string;
  teapplix_sku: string;
  title: string;
  shipped_revenue: number | null;
  shipped_cogs: number | null;
  ordered_units: number | null;
  raw_ordered_units: number | null;  // original ARA order count (pre-pack-multiply)
  pack_qty: number | null;           // pack multiplier applied (null = 1, no badge)
  sales_discount: number | null;
  net_ppm: number | null;
  roos_percent: number | null;
  // ── Ad spend fields (null when ads-sync not yet run) ──────────────────
  ad_spend: number | null;
  ad_sales: number | null;
  coupon_spend: number | null;
  coupon_redemptions: number | null;  // direct from SP-API; null = proportional fallback used
  promotion_spend: number | null;     // from GET_PROMOTION_PERFORMANCE_REPORT
  promo_redemptions: number | null;   // from GET_PROMOTION_PERFORMANCE_REPORT
  acos: number | null;               // ad_spend / ad_sales * 100
  contribution_ppm: number | null;   // (rev - cogs - ad - coupon - promo) / rev * 100
}

interface Kpis {
  shipped_revenue: number;
  shipped_revenue_delta: number | null;
  net_ppm: number | null;
  net_ppm_delta: number | null;       // pp change vs prior period
  sales_discount: number;
  sales_discount_delta: number | null;
  avg_roos: number | null;
  // ── Ad spend KPIs ──────────────────────────────────────────────────────
  total_ad_spend: number;
  total_ad_spend_delta: number | null;
  total_coupon_spend: number;
  total_promotion_spend: number;      // from GET_PROMOTION_PERFORMANCE_REPORT
  roas: number | null;               // total ad_sales / total ad_spend
  high_acos_count: number;           // ASINs where ACOS ≥ 45%
}

interface ApiResponse {
  period: number;
  currentStart: string;
  currentEnd: string;
  dataAvailableDays: number | null;
  roosDataAvailable: boolean;
  salesDiscountDataAvailable: boolean;
  adSpendDataAvailable: boolean;
  couponDataAvailable: boolean;       // true = per-ASIN direct data; false = proportional fallback
  promotionDataAvailable: boolean;    // true = promotions report synced for this period
  kpis: Kpis;
  asins: AsinRow[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtPct(v: number | null, decimals = 1): string {
  if (v == null) return '—';
  return v.toFixed(decimals) + '%';
}

function fmtNum(v: number | null): string {
  if (v == null) return '—';
  return new Intl.NumberFormat('en-US').format(v);
}

function pctDeltaLabel(delta: number | null): string | undefined {
  if (delta == null) return undefined;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}% vs prior period`;
}

function ppDeltaLabel(delta: number | null): string | undefined {
  if (delta == null) return undefined;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)} pp vs prior period`;
}

// ---------------------------------------------------------------------------
// Needs-Attention strip
// ---------------------------------------------------------------------------

type AttentionFilter = 'negative_margin' | 'thin_margin' | 'cogs_gte_revenue' | 'at_risk_revenue' | 'high_acos' | null;

interface AttentionStats {
  negativeMarginCount: number;
  thinMarginCount: number;
  cogsGteRevenueCount: number;
  atRiskRevenue: number;
  highAcosCount: number;  // ASINs with ACOS ≥ 45%
}

function computeAttentionStats(asins: AsinRow[]): AttentionStats {
  let negativeMarginCount = 0;
  let thinMarginCount = 0;
  let cogsGteRevenueCount = 0;
  let atRiskRevenue = 0;
  let highAcosCount = 0;

  const atRiskSet = new Set<string>();

  for (const a of asins) {
    const ppm = a.net_ppm;
    const rev = a.shipped_revenue ?? 0;
    const cogs = a.shipped_cogs ?? 0;

    if (ppm != null && ppm < 0) {
      negativeMarginCount++;
      atRiskSet.add(a.asin);
    }
    if (ppm != null && ppm >= 0 && ppm < 10) {
      thinMarginCount++;
      atRiskSet.add(a.asin);
    }
    if (cogs >= rev && rev > 0) {
      cogsGteRevenueCount++;
      atRiskSet.add(a.asin);
    }
    if (a.acos != null && a.acos >= 45) {
      highAcosCount++;
    }
  }

  for (const a of asins) {
    if (atRiskSet.has(a.asin)) {
      atRiskRevenue += a.shipped_revenue ?? 0;
    }
  }

  return { negativeMarginCount, thinMarginCount, cogsGteRevenueCount, atRiskRevenue, highAcosCount };
}

function filterByAttention(asins: AsinRow[], filter: AttentionFilter): AsinRow[] {
  if (!filter) return asins;
  return asins.filter((a) => {
    const ppm = a.net_ppm;
    const rev = a.shipped_revenue ?? 0;
    const cogs = a.shipped_cogs ?? 0;
    if (filter === 'negative_margin')  return ppm != null && ppm < 0;
    if (filter === 'thin_margin')      return ppm != null && ppm >= 0 && ppm < 10;
    if (filter === 'cogs_gte_revenue') return cogs >= rev && rev > 0;
    if (filter === 'high_acos')        return a.acos != null && a.acos >= 45;
    if (filter === 'at_risk_revenue') {
      return (
        (ppm != null && ppm < 0) ||
        (ppm != null && ppm >= 0 && ppm < 10) ||
        (cogs >= rev && rev > 0)
      );
    }
    return true;
  });
}

function NeedsAttentionStrip({
  asins,
  activeFilter,
  onFilterChange,
  showAcos,
}: {
  asins: AsinRow[];
  activeFilter: AttentionFilter;
  onFilterChange: (f: AttentionFilter) => void;
  showAcos: boolean;
}) {
  const stats = useMemo(() => computeAttentionStats(asins), [asins]);

  function toggle(f: NonNullable<AttentionFilter>) {
    onFilterChange(activeFilter === f ? null : f);
  }

  const chip = (
    filter: NonNullable<AttentionFilter>,
    label: string,
    count: number | string,
    isRevenue = false,
    isOrange = false,
  ) => {
    const isActive   = activeFilter === filter;
    const isZero     = !isRevenue && (count as number) === 0;
    const dangerChip = !isZero && !isRevenue && !isOrange;

    return (
      <button
        onClick={() => toggle(filter)}
        className={[
          'flex items-center gap-2 px-4 py-2.5 rounded-xl border text-left transition-all select-none',
          isActive
            ? isOrange
              ? 'bg-orange-900/60 border-orange-600/70 ring-1 ring-orange-500/50'
              : 'bg-red-900/60 border-red-600/70 ring-1 ring-red-500/50'
            : isZero
            ? 'bg-surface-elevated/40 border-surface-border/40 opacity-60 cursor-default'
            : isOrange
            ? 'bg-orange-950/40 border-orange-800/60 hover:border-orange-600/60 hover:bg-orange-900/30'
            : 'bg-surface-elevated border-surface-border hover:border-surface-hover hover:bg-surface-hover/40',
        ].join(' ')}
        disabled={isZero}
        title={isActive ? 'Click to clear filter' : 'Click to filter table'}
      >
        <span className={[
          'text-lg font-bold tabular-nums leading-none',
          isActive
            ? isOrange ? 'text-orange-300' : 'text-red-300'
            : isZero
            ? 'text-emerald-500'
            : isOrange
            ? 'text-orange-400'
            : dangerChip
            ? 'text-red-400'
            : 'text-amber-400',
        ].join(' ')}>
          {typeof count === 'number' && isRevenue ? formatUSD(count) : String(count)}
        </span>
        <span className="text-xs text-text-muted leading-tight">{label}</span>
        {isActive && (
          <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide" style={{ color: isOrange ? '#fb923c' : '#f87171' }}>active</span>
        )}
      </button>
    );
  };

  return (
    <div className="bg-surface-card rounded-2xl border border-surface-border px-4 py-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-text-muted uppercase tracking-widest">Needs Attention</span>
        {activeFilter && (
          <button
            onClick={() => onFilterChange(null)}
            className="text-xs text-text-muted hover:text-text-primary transition-colors"
          >
            Clear filter ×
          </button>
        )}
      </div>
      <div className={`grid grid-cols-2 ${showAcos && stats.highAcosCount > 0 ? 'sm:grid-cols-5' : 'sm:grid-cols-4'} gap-2`}>
        {chip('negative_margin',  'ASINs · Net PPM < 0',           stats.negativeMarginCount)}
        {chip('thin_margin',      'ASINs · Net PPM 0–10%',         stats.thinMarginCount)}
        {chip('cogs_gte_revenue', 'ASINs · COGS ≥ Revenue',        stats.cogsGteRevenueCount)}
        {chip('at_risk_revenue',  'Revenue tied up in at-risk',    stats.atRiskRevenue, true)}
        {showAcos && stats.highAcosCount > 0 && (
          chip('high_acos', 'ASINs · ACOS ≥ 45%', stats.highAcosCount, false, true)
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Family grouping — group ASINs by getFamilySku(teapplix_sku)
// ---------------------------------------------------------------------------

interface FamilyRow {
  family: string;           // family SKU label (e.g. "AM5237")
  shipped_revenue: number;
  shipped_cogs: number;
  ordered_units: number;
  sales_discount: number;
  ad_spend: number;
  coupon_spend: number;
  promotion_spend: number;          // from GET_PROMOTION_PERFORMANCE_REPORT
  net_ppm: number | null;           // recomputed from summed revenue/cogs
  contribution_ppm: number | null;  // recomputed with ad+coupon+promo friction
  asins: AsinRow[];                 // individual ASINs nested under this family
}

/**
 * Revenue-weighted Net PPM at family level.
 * Uses each ASIN's ARA net_ppm weighted by its shipped_revenue —
 * matches the same weighting Amazon uses internally.
 * Do NOT recompute from shipped_cogs: ARA cogs and net_ppm use different
 * cost bases, so (rev - cogs) / rev gives wrong numbers.
 */
function computeFamilyNetPpm(asins: AsinRow[]): number | null {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const a of asins) {
    if (a.net_ppm != null && a.shipped_revenue != null && a.shipped_revenue > 0) {
      weightedSum += a.net_ppm * a.shipped_revenue;
      totalWeight += a.shipped_revenue;
    }
  }
  return totalWeight > 0 ? weightedSum / totalWeight : null;
}

function groupAsinsByFamily(asins: AsinRow[]): FamilyRow[] {
  const familyMap   = new Map<string, FamilyRow>();
  const familyOrder = new Map<string, number>();

  for (const asin of asins) {
    const family = (asin.teapplix_sku && asin.teapplix_sku !== '—')
      ? familyKey(asin.teapplix_sku)
      : asin.asin;

    if (!familyMap.has(family)) {
      familyOrder.set(family, familyOrder.size);
      familyMap.set(family, {
        family,
        shipped_revenue:  0,
        shipped_cogs:     0,
        ordered_units:    0,
        sales_discount:   0,
        ad_spend:         0,
        coupon_spend:     0,
        promotion_spend:  0,
        net_ppm:          null,
        contribution_ppm: null,
        asins:            [],
      });
    }
    const row = familyMap.get(family)!;
    row.shipped_revenue  += asin.shipped_revenue  ?? 0;
    row.shipped_cogs     += asin.shipped_cogs     ?? 0;
    row.ordered_units    += asin.ordered_units    ?? 0;
    row.sales_discount   += asin.sales_discount   ?? 0;
    row.ad_spend         += asin.ad_spend         ?? 0;
    row.coupon_spend     += asin.coupon_spend      ?? 0;
    row.promotion_spend  += asin.promotion_spend  ?? 0;
    row.asins.push(asin);
  }

  for (const row of familyMap.values()) {
    row.net_ppm = computeFamilyNetPpm(row.asins);
    // Contribution PPM % at family level: (rev - cogs - ad - coupon - promo) / rev * 100
    if (row.shipped_revenue > 0) {
      row.contribution_ppm =
        (row.shipped_revenue - row.shipped_cogs - row.ad_spend - row.coupon_spend - row.promotion_spend)
        / row.shipped_revenue * 100;
    }
  }

  return [...familyMap.entries()]
    .sort((a, b) => (familyOrder.get(a[0]) ?? 0) - (familyOrder.get(b[0]) ?? 0))
    .map(([, row]) => row)
    .sort((a, b) => b.shipped_revenue - a.shipped_revenue);
}

// ---------------------------------------------------------------------------
// Highlight logic
// ---------------------------------------------------------------------------

function netPpmBg(ppm: number | null): string {
  if (ppm == null) return '';
  if (ppm < 0)    return 'text-red-400 font-semibold';
  if (ppm < 5)    return 'text-amber-400 font-semibold';  // 0–5%: thin margin
  if (ppm < 10)   return 'text-yellow-300 font-semibold'; // 5–10%: moderate
  return 'text-gray-700 dark:text-text-secondary'; // 10%+: healthy
}

// Contribution PPM uses same colour scale as Net PPM
function contribPpmBg(ppm: number | null): string {
  return netPpmBg(ppm);
}

function discountAlert(discount: number | null, revenue: number | null): boolean {
  if (discount == null || revenue == null || revenue === 0) return false;
  return (discount / revenue) > 0.15;
}

function RoosBadge({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-gray-400 dark:text-text-muted tabular-nums">—</span>;
  if (pct > 10) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-900 text-red-300 ring-1 ring-red-700 tabular-nums">
        {pct.toFixed(1)}%
      </span>
    );
  }
  return <span className="tabular-nums text-gray-700 dark:text-text-secondary">{pct.toFixed(1)}%</span>;
}

// ---------------------------------------------------------------------------
// Period selector
// ---------------------------------------------------------------------------

const PERIODS = [
  { label: '7d',  value: 7   },
  { label: '30d', value: 30  },
  { label: '90d', value: 90  },
  { label: '1y',  value: 365 },
] as const;

type Period = typeof PERIODS[number]['value'];

/** Returns true if the requested period exceeds available synced data. */
function isPartialPeriod(period: number, dataAvailableDays: number | null): boolean {
  if (dataAvailableDays == null) return false;
  return period > dataAvailableDays;
}

// ---------------------------------------------------------------------------
// Sortable grouped table (families collapsed, ASINs expandable)
// ---------------------------------------------------------------------------

type SortKey = 'family' | 'shipped_revenue' | 'shipped_cogs' | 'net_ppm' | 'sales_discount' | 'ordered_units' | 'ad_spend' | 'coupon_spend' | 'promotion_spend' | 'contribution_ppm';

function FamilyTable({
  rows,
  showRoos,
  showDiscount,
  showAdSpend,
  showPromo,
}: {
  rows: AsinRow[];
  showRoos: boolean;
  showDiscount: boolean;
  showAdSpend: boolean;
  showPromo: boolean;
}) {
  const [sortKey, setSortKey]   = useState<SortKey>('shipped_revenue');
  const [sortAsc, setSortAsc]   = useState(false);
  const [search,  setSearch]    = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(false); }
  }

  function toggleExpand(family: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(family) ? next.delete(family) : next.add(family);
      return next;
    });
  }

  const families = useMemo(() => groupAsinsByFamily(rows), [rows]);

  // Search: match family name OR any nested ASIN/SKU, auto-expand matched families
  const { filteredFamilies, autoExpanded } = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return { filteredFamilies: families, autoExpanded: new Set<string>() };

    const autoExp = new Set<string>();
    const filtered = families.filter((fam) => {
      const familyMatch = fam.family.toLowerCase().includes(q);
      const asinMatch = fam.asins.some(
        (a) => a.asin.toLowerCase().includes(q) || a.teapplix_sku.toLowerCase().includes(q)
      );
      if (asinMatch && !familyMatch) autoExp.add(fam.family);
      return familyMatch || asinMatch;
    });
    return { filteredFamilies: filtered, autoExpanded: autoExp };
  }, [families, search]);

  const sorted = useMemo(() => {
    return [...filteredFamilies].sort((a, b) => {
      const av = a[sortKey as keyof FamilyRow] ?? (sortAsc ? Infinity : -Infinity);
      const bv = b[sortKey as keyof FamilyRow] ?? (sortAsc ? Infinity : -Infinity);
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortAsc
        ? (av < bv ? -1 : av > bv ? 1 : 0)
        : (av > bv ? -1 : av < bv ? 1 : 0);
    });
  }, [filteredFamilies, sortKey, sortAsc]);

  const thCls = 'px-3 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-text-primary select-none whitespace-nowrap';
  const thR = thCls + ' text-right';
  const arrow = (key: SortKey) => sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : '';

  const colSpan = 2 + 3 + (showDiscount ? 1 : 0) + 1 + (showRoos ? 1 : 0) + (showAdSpend ? 3 : 0) + (showPromo ? 1 : 0);

  return (
    <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-200 dark:border-surface-border overflow-hidden">
      {/* Search */}
      <div className="px-4 py-3 border-b border-gray-100 dark:border-surface-border">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by family SKU, ASIN, or Teapplix SKU…"
          className="w-full max-w-sm text-sm px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-surface-elevated border border-gray-200 dark:border-surface-border text-gray-800 dark:text-text-primary placeholder-gray-400 dark:placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-surface-border bg-gray-50 dark:bg-surface-elevated">
              <th className={`${thCls} text-left`} onClick={() => toggleSort('family')}>Family SKU / ASIN{arrow('family')}</th>
              <th className={`${thCls} text-left`}>Title / ASINs</th>
              <th className={thR} onClick={() => toggleSort('shipped_revenue')}>Shipped Revenue{arrow('shipped_revenue')}</th>
              <th className={thR} onClick={() => toggleSort('shipped_cogs')}>Shipped COGS{arrow('shipped_cogs')}</th>
              {showAdSpend && (
                <th className={thR} onClick={() => toggleSort('ad_spend')}>Ad Spend{arrow('ad_spend')}</th>
              )}
              {showAdSpend && (
                <th className={thR} onClick={() => toggleSort('coupon_spend')}>Coupon Spend{arrow('coupon_spend')}</th>
              )}
              {showAdSpend && showPromo && (
                <th className={thR} onClick={() => toggleSort('promotion_spend')}>Promotions{arrow('promotion_spend')}</th>
              )}
              <th className={thR} onClick={() => toggleSort('net_ppm')}>Net PPM %{arrow('net_ppm')}</th>
              {showAdSpend && (
                <th className={thR} onClick={() => toggleSort('contribution_ppm')}>Contribution PPM %{arrow('contribution_ppm')}</th>
              )}
              {showDiscount && (
                <th className={thR} onClick={() => toggleSort('sales_discount')}>Sales Discount${arrow('sales_discount')}</th>
              )}
              <th className={thR} onClick={() => toggleSort('ordered_units')}>Ordered Units{arrow('ordered_units')}</th>
              {showRoos && <th className={thR}>ROOS %</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-surface-border">
            {sorted.map((fam) => {
              const isSingle = fam.asins.length === 1;
              const isExp = expanded.has(fam.family) || autoExpanded.has(fam.family);
              const deepDiscount = discountAlert(fam.sales_discount, fam.shipped_revenue);
              // For single-ASIN families show ROOS directly; multi-family shows — at family level
              const singleAsin = isSingle ? fam.asins[0] : null;

              return (
                <>
                  {/* Family / parent row */}
                  <tr
                    key={fam.family}
                    className={`hover:bg-gray-50 dark:hover:bg-surface-hover transition-colors ${!isSingle ? 'cursor-pointer' : ''}`}
                    onClick={() => !isSingle && toggleExpand(fam.family)}
                  >
                    {/* Family SKU */}
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1.5">
                        {!isSingle && (
                          <span className="text-gray-400 dark:text-text-muted text-xs">
                            {isExp ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </span>
                        )}
                        <div>
                          <div className="font-mono text-sm font-semibold text-gray-900 dark:text-text-primary">
                            {fam.family}
                          </div>
                          {!isSingle && (
                            <div className="text-xs text-gray-400 dark:text-text-muted mt-0.5">
                              {fam.asins.length} ASINs
                            </div>
                          )}
                          {isSingle && singleAsin && singleAsin.teapplix_sku !== '—' && (
                            <div className="text-xs text-gray-400 dark:text-text-muted mt-0.5 font-mono">
                              {singleAsin.asin}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Title / nested ASINs preview */}
                    <td className="px-3 py-3 max-w-[220px]">
                      {isSingle && singleAsin ? (
                        <span className="text-xs text-gray-600 dark:text-text-secondary line-clamp-2 leading-relaxed">
                          {singleAsin.title || '—'}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400 dark:text-text-muted italic">
                          {isExp ? 'Click to collapse' : 'Click to expand ASINs'}
                        </span>
                      )}
                    </td>

                    {/* Shipped Revenue */}
                    <td className="px-3 py-3 text-right tabular-nums text-gray-700 dark:text-text-secondary font-semibold">
                      {formatUSD(fam.shipped_revenue)}
                    </td>

                    {/* Shipped COGS */}
                    <td className="px-3 py-3 text-right tabular-nums text-gray-700 dark:text-text-secondary">
                      {formatUSD(fam.shipped_cogs)}
                    </td>

                    {/* Ad Spend */}
                    {showAdSpend && (
                      <td className="px-3 py-3 text-right tabular-nums text-gray-700 dark:text-text-secondary">
                        {fam.ad_spend > 0 ? formatUSD(fam.ad_spend) : <span className="text-gray-400 dark:text-text-muted">—</span>}
                      </td>
                    )}

                    {/* Coupon Spend */}
                    {showAdSpend && (
                      <td className="px-3 py-3 text-right tabular-nums text-gray-700 dark:text-text-secondary">
                        {fam.coupon_spend > 0 ? formatUSD(fam.coupon_spend) : <span className="text-gray-400 dark:text-text-muted">—</span>}
                      </td>
                    )}

                    {/* Promotions */}
                    {showAdSpend && showPromo && (
                      <td className="px-3 py-3 text-right tabular-nums text-gray-700 dark:text-text-secondary">
                        {fam.promotion_spend > 0
                          ? formatUSD(fam.promotion_spend)
                          : <span className="text-gray-400 dark:text-text-muted">—</span>}
                      </td>
                    )}

                    {/* Net PPM — recomputed from family sums */}
                    <td className={`px-3 py-3 text-right tabular-nums ${netPpmBg(fam.net_ppm)}`}>
                      {fmtPct(fam.net_ppm)}
                    </td>

                    {/* Contribution PPM % */}
                    {showAdSpend && (
                      <td className={`px-3 py-3 text-right tabular-nums ${contribPpmBg(fam.contribution_ppm)}`}>
                        {fmtPct(fam.contribution_ppm)}
                      </td>
                    )}

                    {/* Sales Discount */}
                    {showDiscount && (
                      <td className={`px-3 py-3 text-right tabular-nums ${deepDiscount ? 'text-amber-400 font-semibold' : 'text-gray-700 dark:text-text-secondary'}`}>
                        {formatUSD(fam.sales_discount)}
                        {deepDiscount && (
                          <div className="text-[10px] text-amber-500 font-normal">deep discount</div>
                        )}
                      </td>
                    )}

                    {/* Ordered Units */}
                    <td className="px-3 py-3 text-right tabular-nums text-gray-700 dark:text-text-secondary">
                      {fmtNum(fam.ordered_units)}
                    </td>

                    {/* ROOS — only show at family level for single-ASIN families */}
                    {showRoos && (
                      <td className="px-3 py-3 text-right">
                        {isSingle && singleAsin ? (
                          <RoosBadge pct={singleAsin.roos_percent} />
                        ) : (
                          <span className="text-gray-400 dark:text-text-muted text-xs">—</span>
                        )}
                      </td>
                    )}
                  </tr>

                  {/* Nested ASIN rows (expanded) */}
                  {!isSingle && isExp && fam.asins.map((asin) => {
                    const asinDeepDiscount = discountAlert(asin.sales_discount, asin.shipped_revenue);
                    return (
                      <tr key={asin.asin} className="bg-indigo-50/30 dark:bg-accent-primary/5 hover:bg-indigo-50/50 dark:hover:bg-accent-primary/10 transition-colors">
                        {/* ASIN + SKU */}
                        <td className="px-3 py-2.5 pl-8">
                          <div className="font-mono text-xs font-medium text-gray-700 dark:text-text-secondary">
                            ↳ {asin.asin}
                          </div>
                          {asin.teapplix_sku !== '—' && (
                            <div className="text-[11px] text-gray-400 dark:text-text-muted mt-0.5 font-mono">
                              {asin.teapplix_sku}
                            </div>
                          )}
                        </td>

                        {/* Title */}
                        <td className="px-3 py-2.5 max-w-[220px]">
                          <span className="text-xs text-gray-500 dark:text-text-muted line-clamp-2 leading-relaxed">
                            {asin.title || '—'}
                          </span>
                        </td>

                        <td className="px-3 py-2.5 text-right tabular-nums text-xs text-gray-600 dark:text-text-muted">
                          {formatUSD(asin.shipped_revenue)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-xs text-gray-600 dark:text-text-muted">
                          {formatUSD(asin.shipped_cogs)}
                        </td>
                        {showAdSpend && (
                          <td className="px-3 py-2.5 text-right tabular-nums text-xs text-gray-600 dark:text-text-muted">
                            {(asin.ad_spend ?? 0) > 0 ? formatUSD(asin.ad_spend) : <span className="text-gray-400 dark:text-text-muted">—</span>}
                          </td>
                        )}
                        {showAdSpend && (
                          <td className="px-3 py-2.5 text-right tabular-nums text-xs text-gray-600 dark:text-text-muted">
                            {(asin.coupon_spend ?? 0) > 0
                              ? (
                                <div>
                                  {formatUSD(asin.coupon_spend)}
                                  {asin.coupon_redemptions != null && (
                                    <div className="text-[10px] text-gray-400 dark:text-text-muted font-normal">
                                      {fmtNum(asin.coupon_redemptions)} redemptions
                                    </div>
                                  )}
                                </div>
                              )
                              : <span className="text-gray-400 dark:text-text-muted">—</span>}
                          </td>
                        )}
                        {showAdSpend && showPromo && (
                          <td className="px-3 py-2.5 text-right tabular-nums text-xs text-gray-600 dark:text-text-muted">
                            {(asin.promotion_spend ?? 0) > 0
                              ? (
                                <div>
                                  {formatUSD(asin.promotion_spend)}
                                  {asin.promo_redemptions != null && (
                                    <div className="text-[10px] text-gray-400 dark:text-text-muted font-normal">
                                      {fmtNum(asin.promo_redemptions)} redemptions
                                    </div>
                                  )}
                                </div>
                              )
                              : <span className="text-gray-400 dark:text-text-muted">—</span>}
                          </td>
                        )}
                        <td className={`px-3 py-2.5 text-right tabular-nums text-xs ${netPpmBg(asin.net_ppm)}`}>
                          {fmtPct(asin.net_ppm)}
                        </td>
                        {showAdSpend && (
                          <td className={`px-3 py-2.5 text-right tabular-nums text-xs ${contribPpmBg(asin.contribution_ppm)}`}>
                            {fmtPct(asin.contribution_ppm)}
                          </td>
                        )}
                        {showDiscount && (
                          <td className={`px-3 py-2.5 text-right tabular-nums text-xs ${asinDeepDiscount ? 'text-amber-400 font-semibold' : 'text-gray-600 dark:text-text-muted'}`}>
                            {formatUSD(asin.sales_discount)}
                          </td>
                        )}
                        <td className="px-3 py-2.5 text-right tabular-nums text-xs text-gray-600 dark:text-text-muted">
                          {fmtNum(asin.ordered_units)}
                          {asin.raw_ordered_units != null && asin.pack_qty != null && (
                            <div className="text-[10px] text-gray-400 dark:text-text-muted font-normal">
                              {fmtNum(asin.raw_ordered_units)} orders ×{asin.pack_qty}
                            </div>
                          )}
                        </td>
                        {showRoos && (
                          <td className="px-3 py-2.5 text-right">
                            <RoosBadge pct={asin.roos_percent} />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </>
              );
            })}

            {sorted.length === 0 && (
              <tr>
                <td colSpan={colSpan} className="px-4 py-12 text-center text-sm text-gray-400 dark:text-text-muted">
                  No data found for this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="border-t border-gray-100 dark:border-surface-border px-4 py-3 bg-gray-50 dark:bg-surface-elevated text-xs text-gray-400 dark:text-text-muted flex items-center justify-between flex-wrap gap-2">
        <span>
          {sorted.length} famil{sorted.length !== 1 ? 'ies' : 'y'}
          {' · '}
          {rows.length} ASINs
          {' · '}
          Net PPM % revenue-weighted average of ASIN values
        </span>
        <span className="flex gap-3">
          <span><span className="inline-block w-2 h-2 rounded-full bg-red-400 mr-1" />Net PPM &lt; 0 = losing money</span>
          <span><span className="inline-block w-2 h-2 rounded-full bg-amber-400 mr-1" />0–10% = thin/moderate margin</span>
          {showRoos && (
            <span><span className="inline-block w-2 h-2 rounded-full bg-red-400 mr-1" />ROOS &gt; 10% = OOS lost sales</span>
          )}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function VendorCentralPage() {
  const [period,        setPeriod]        = useState<Period>(30);
  const [data,          setData]          = useState<ApiResponse | null>(null);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState<string | null>(null);
  const [attentionFilter, setAttentionFilter] = useState<AttentionFilter>(null);

  const fetchData = useCallback((p: Period) => {
    setLoading(true);
    setError(null);
    fetch(`/api/vendor-central?period=${p}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: ApiResponse) => {
        if (json.error) throw new Error(json.error);
        setData(json);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchData(period); setAttentionFilter(null); }, [period, fetchData]);

  const filteredAsins = useMemo(
    () => filterByAttention(data?.asins ?? [], attentionFilter),
    [data?.asins, attentionFilter],
  );

  const pillBase   = 'px-3 py-1.5 rounded-full text-xs font-medium transition-colors';
  const pillActive = 'bg-accent-primary text-white';
  const pillInact  = 'text-gray-500 dark:text-text-secondary hover:text-gray-900 dark:hover:text-text-primary hover:bg-gray-100 dark:hover:bg-surface-hover';

  const kpis = data?.kpis;

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-surface">

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="bg-white dark:bg-surface-card border-b border-gray-200 dark:border-surface-border px-4 md:px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-text-primary">
              Vendor Central
            </h1>
            <p className="text-xs text-gray-400 dark:text-text-muted mt-0.5">
              Amazon Retail Analytics (ARA) — shipped &amp; margin data
            </p>
          </div>

          {/* Period selector */}
          <div className="flex items-center gap-1">
            {PERIODS.map(({ label, value }) => {
              const partial = isPartialPeriod(value, data?.dataAvailableDays ?? null);
              return (
                <button
                  key={value}
                  onClick={() => setPeriod(value)}
                  className={`${pillBase} ${period === value ? pillActive : pillInact} relative`}
                  title={partial ? `Only ~${data?.dataAvailableDays ?? 14}d of data synced` : undefined}
                >
                  {label}
                  {partial && (
                    <span className="ml-1 text-[10px] text-amber-400 font-normal">partial</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── ARA lag notice ───────────────────────────────────────────────── */}
      <div className="bg-amber-950/50 border-b border-amber-800/60 px-4 md:px-6 py-2.5">
        <div className="max-w-7xl mx-auto text-xs text-amber-300/90 flex items-center gap-2">
          <span className="text-amber-400">⚠</span>
          <span>
            <strong>Amazon Retail Analytics</strong> — reflects ~4-day reporting lag.
            Not comparable to real-time Teapplix order data above.
          </span>
        </div>
      </div>

      {/* ── Partial data notice ──────────────────────────────────────────────── */}
      {!loading && data && isPartialPeriod(period, data.dataAvailableDays) && (
        <div className="bg-blue-950/50 border-b border-blue-800/60 px-4 md:px-6 py-2.5">
          <div className="max-w-7xl mx-auto text-xs text-blue-300/90 flex items-center gap-2">
            <span className="text-blue-400">ℹ</span>
            <span>
              <strong>Partial data</strong> — sync covers ~{data.dataAvailableDays ?? 14} days.
              The selected {period === 365 ? '1-year' : `${period}-day`} period shows only available data.
              Run a sync to extend history.
            </span>
          </div>
        </div>
      )}

      {/* ── Error banner ─────────────────────────────────────────────────── */}
      {error && (
        <div className="bg-red-950 border-b border-red-800 px-4 md:px-6 py-3">
          <div className="max-w-7xl mx-auto text-sm text-red-300">
            <span className="font-semibold">⚠ Fetch failed</span>
            <span className="text-red-400"> — {error}</span>
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 md:px-6 py-6 md:py-8 space-y-8">

        {/* ── KPI row ────────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-xs font-semibold text-gray-400 dark:text-text-muted uppercase tracking-widest mb-3">
            Vendor Performance — {period === 365 ? '1 Year' : `${period} Days`}
          </h2>

          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-28 bg-gray-100 dark:bg-surface-elevated rounded-2xl animate-pulse" />
              ))}
            </div>
          ) : (
            (() => {
              const showDiscount = data?.salesDiscountDataAvailable !== false;
              const showRoosCard = data?.roosDataAvailable !== false;
              const colCount = 2 + (showDiscount ? 1 : 0) + (showRoosCard ? 1 : 0);
              const colCls = colCount === 4 ? 'lg:grid-cols-4' : colCount === 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-2';
              return (
                <div className={`grid grid-cols-1 sm:grid-cols-2 ${colCls} gap-4`}>
                  <KpiCard
                    label="Shipped Revenue"
                    value={kpis ? formatUSD(kpis.shipped_revenue) : '—'}
                    subLabel={pctDeltaLabel(kpis?.shipped_revenue_delta ?? null)}
                    deltaPositive={
                      kpis?.shipped_revenue_delta != null
                        ? kpis.shipped_revenue_delta >= 0
                        : undefined
                    }
                    icon={<DollarSign size={14} />}
                    accentColor="border-l-accent-emerald"
                  />
                  <KpiCard
                    label="Net PPM"
                    value={kpis?.net_ppm != null ? fmtPct(kpis.net_ppm) : '—'}
                    subLabel={ppDeltaLabel(kpis?.net_ppm_delta ?? null)}
                    deltaPositive={
                      kpis?.net_ppm_delta != null ? kpis.net_ppm_delta >= 0 : undefined
                    }
                    icon={<TrendingUp size={14} />}
                    accentColor={
                      kpis?.net_ppm == null
                        ? 'border-l-accent-primary'
                        : kpis.net_ppm < 0
                        ? 'border-l-accent-red'
                        : kpis.net_ppm < 10
                        ? 'border-l-accent-amber'
                        : 'border-l-accent-emerald'
                    }
                  />
                  {showDiscount && (
                    <KpiCard
                      label="Sales Discount"
                      value={kpis ? formatUSD(kpis.sales_discount) : '—'}
                      subLabel={pctDeltaLabel(kpis?.sales_discount_delta ?? null)}
                      deltaPositive={
                        kpis?.sales_discount_delta != null
                          ? kpis.sales_discount_delta <= 0
                          : undefined
                      }
                      icon={<Tag size={14} />}
                      accentColor="border-l-accent-amber"
                    />
                  )}
                  {showRoosCard && (
                    <KpiCard
                      label="Avg ROOS"
                      value={kpis?.avg_roos != null ? fmtPct(kpis.avg_roos) : '—'}
                      subLabel="Period-avg out-of-stock rate across ASINs"
                      deltaPositive={
                        kpis?.avg_roos != null ? kpis.avg_roos <= 5 : undefined
                      }
                      icon={<AlertTriangle size={14} />}
                      accentColor={
                        kpis?.avg_roos == null
                          ? 'border-l-accent-primary'
                          : kpis.avg_roos > 10
                          ? 'border-l-accent-red'
                          : 'border-l-accent-emerald'
                      }
                    />
                  )}
                </div>
              );
            })()
          )}
        </section>

        {/* ── Ad Spend KPI row (only when ads-sync has been run) ────────── */}
        {!loading && data?.adSpendDataAvailable && (
          <section>
            <h2 className="text-xs font-semibold text-gray-400 dark:text-text-muted uppercase tracking-widest mb-3">
              Advertising Performance — {period === 365 ? '1 Year' : `${period} Days`}
            </h2>
            <div className={`grid grid-cols-1 sm:grid-cols-2 ${data?.promotionDataAvailable ? 'lg:grid-cols-4' : 'lg:grid-cols-3'} gap-4`}>
              <KpiCard
                label="Total Ad Spend"
                value={kpis ? formatUSD(kpis.total_ad_spend) : '—'}
                subLabel={pctDeltaLabel(kpis?.total_ad_spend_delta ?? null)}
                deltaPositive={
                  kpis?.total_ad_spend_delta != null
                    ? kpis.total_ad_spend_delta <= 0   // lower spend = positive
                    : undefined
                }
                icon={<Zap size={14} />}
                accentColor="border-l-accent-red"
              />
              <KpiCard
                label="Coupon Spend"
                value={kpis ? formatUSD(kpis.total_coupon_spend) : '—'}
                subLabel={
                  data?.couponDataAvailable
                    ? 'Direct per-ASIN from SP-API'
                    : 'Estimated (proportional allocation)'
                }
                icon={<ShoppingBag size={14} />}
                accentColor="border-l-accent-amber"
              />
              {data?.promotionDataAvailable && (
                <KpiCard
                  label="Promotions Spend"
                  value={kpis ? formatUSD(kpis.total_promotion_spend) : '—'}
                  subLabel="Total discount given via promotions"
                  icon={<Tag size={14} />}
                  accentColor="border-l-accent-amber"
                />
              )}
              <KpiCard
                label="ROAS"
                value={kpis?.roas != null ? `${kpis.roas.toFixed(2)}×` : '—'}
                subLabel="Ad sales ÷ Ad spend (Sponsored Products)"
                deltaPositive={kpis?.roas != null ? kpis.roas >= 3 : undefined}
                icon={<BarChart2 size={14} />}
                accentColor={
                  kpis?.roas == null
                    ? 'border-l-accent-primary'
                    : kpis.roas < 2
                    ? 'border-l-accent-red'
                    : kpis.roas < 3
                    ? 'border-l-accent-amber'
                    : 'border-l-accent-emerald'
                }
              />
            </div>
          </section>
        )}

        {/* ── Needs-Attention strip ─────────────────────────────────────── */}
        {!loading && data && data.asins.length > 0 && (
          <NeedsAttentionStrip
            asins={data.asins}
            activeFilter={attentionFilter}
            onFilterChange={setAttentionFilter}
            showAcos={data.adSpendDataAvailable !== false}
          />
        )}

        {/* ── ASIN table ─────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-xs font-semibold text-gray-400 dark:text-text-muted uppercase tracking-widest mb-3">
            ASIN Performance{attentionFilter && <span className="ml-2 text-red-400 normal-case tracking-normal">· filtered</span>}
          </h2>
          {loading ? (
            <div className="space-y-3">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 dark:bg-surface-elevated rounded-xl animate-pulse" />
              ))}
            </div>
          ) : (
            <FamilyTable
              rows={filteredAsins}
              showRoos={data?.roosDataAvailable !== false}
              showDiscount={data?.salesDiscountDataAvailable !== false}
              showAdSpend={data?.adSpendDataAvailable !== false}
              showPromo={data?.promotionDataAvailable === true}
            />
          )}
        </section>
      </div>
    </main>
  );
}
