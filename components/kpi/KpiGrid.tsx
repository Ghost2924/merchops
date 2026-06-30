import KpiCard from './KpiCard';
import SyncButton from './SyncButton';
import MtdSparkline from './MtdSparkline';
import { DailySummary, VolatilityEntry } from '@/lib/data/types';
import { formatUSD, formatCount } from '@/lib/formatters';
import { ShoppingCart, DollarSign, TrendingUp, AlertTriangle, BarChart2, Wallet } from 'lucide-react';

interface KpiGridProps {
  todaySummary: DailySummary | null;
  mtdSummaries?: DailySummary[];
  priorMtdSummaries?: DailySummary[];
  volatilityEntries?: VolatilityEntry[];
  lowStockDays?: number;
  todayNetProfit?: { revenue: number; cogs: number; marketing_spend: number; net_profit: number } | null;
}

function pctDelta(current: number, prior: number): string | null {
  if (prior === 0) return null;
  const pct = ((current - prior) / prior) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}% vs prior period`;
}

export default function KpiGrid({
  todaySummary,
  mtdSummaries = [],
  priorMtdSummaries = [],
  volatilityEntries = [],
  lowStockDays = 14,
  todayNetProfit = null,
}: KpiGridProps) {
  const orders = todaySummary ? formatCount(todaySummary.orderCount) : '—';
  const revenue = todaySummary ? formatUSD(todaySummary.totalRevenue) : '—';
  const aov = todaySummary ? formatUSD(todaySummary.aov) : '—';

  const mtdRevenue = mtdSummaries.reduce((s, d) => s + d.totalRevenue, 0);
  const mtdOrders = mtdSummaries.reduce((s, d) => s + d.orderCount, 0);
  const priorRevenue = priorMtdSummaries.reduce((s, d) => s + d.totalRevenue, 0);
  const priorOrders = priorMtdSummaries.reduce((s, d) => s + d.orderCount, 0);

  const revenueDelta = mtdSummaries.length > 0 ? pctDelta(mtdRevenue, priorRevenue) : null;
  const ordersDelta = mtdSummaries.length > 0 ? pctDelta(mtdOrders, priorOrders) : null;

  const lowStockCount = volatilityEntries.filter(
    (e) => e.daysOfSupply !== null && e.daysOfSupply <= lowStockDays
  ).length;

  // Net profit derived values
  const netProfitValue = todayNetProfit ? formatUSD(todayNetProfit.net_profit) : '—';
  const marginPct =
    todayNetProfit && todayNetProfit.revenue > 0
      ? ((todayNetProfit.net_profit / todayNetProfit.revenue) * 100).toFixed(1)
      : null;
  const marginPositive = todayNetProfit ? todayNetProfit.net_profit >= 0 : undefined;
  const netProfitSubLabel = marginPct !== null ? `${marginPct}% margin today` : 'Net of COGS + ads + coupons';

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <KpiCard
          label="Orders Today"
          value={orders}
          subLabel={ordersDelta ?? undefined}
          deltaPositive={ordersDelta ? mtdOrders >= priorOrders : undefined}
          icon={<ShoppingCart size={14} />}
          accentColor="border-l-accent-primary"
        />
        <KpiCard
          label="Revenue Today"
          value={revenue}
          subLabel={revenueDelta ?? undefined}
          deltaPositive={revenueDelta ? mtdRevenue >= priorRevenue : undefined}
          icon={<DollarSign size={14} />}
          accentColor="border-l-accent-emerald"
        />
        <KpiCard
          label="Net Profit Today"
          value={netProfitValue}
          subLabel={netProfitSubLabel}
          deltaPositive={marginPositive}
          icon={<Wallet size={14} />}
          accentColor={
            marginPositive === false
              ? 'border-l-accent-red'
              : marginPct !== null && parseFloat(marginPct) >= 20
              ? 'border-l-accent-emerald'
              : 'border-l-accent-amber'
          }
          extra={
            marginPct !== null && todayNetProfit ? (
              <div className="mt-1 space-y-1">
                {/* Margin bar */}
                <div className="flex items-center gap-2">
                  <div className="flex-1 bg-gray-100 dark:bg-surface-elevated rounded-full h-1.5 overflow-hidden">
                    <div
                      className={`h-1.5 rounded-full transition-all ${
                        parseFloat(marginPct) >= 20
                          ? 'bg-accent-emerald'
                          : parseFloat(marginPct) >= 0
                          ? 'bg-accent-amber'
                          : 'bg-accent-red'
                      }`}
                      style={{ width: `${Math.min(Math.max(parseFloat(marginPct), 0), 100)}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-bold text-gray-500 dark:text-text-muted w-10 text-right tabular-nums">
                    {marginPct}%
                  </span>
                </div>
                {/* Cost pills */}
                <div className="flex gap-1 flex-wrap">
                  <span className="text-[10px] bg-gray-100 dark:bg-surface-elevated text-gray-500 dark:text-text-muted rounded px-1.5 py-0.5">
                    COGS {formatUSD(todayNetProfit.cogs)}
                  </span>
                  <span className="text-[10px] bg-gray-100 dark:bg-surface-elevated text-gray-500 dark:text-text-muted rounded px-1.5 py-0.5">
                    Ads+Coupons {formatUSD(todayNetProfit.marketing_spend)}
                  </span>
                </div>
              </div>
            ) : null
          }
        />
        <KpiCard
          label="AOV"
          value={aov}
          subLabel="Average Order Value"
          icon={<TrendingUp size={14} />}
          accentColor="border-l-accent-violet"
        />
        <KpiCard
          label="Low Stock SKUs"
          value={lowStockCount === 0 ? '✓ All OK' : String(lowStockCount)}
          subLabel={lowStockCount > 0 ? `SKUs with ≤${lowStockDays} days supply` : 'No reorder needed'}
          deltaPositive={lowStockCount === 0 ? true : false}
          highlight={lowStockCount > 0}
          icon={<AlertTriangle size={14} />}
        />
        <KpiCard
          label="MTD Revenue"
          value={formatUSD(mtdRevenue)}
          subLabel={revenueDelta ?? 'Month to date'}
          deltaPositive={revenueDelta ? mtdRevenue >= priorRevenue : undefined}
          icon={<BarChart2 size={14} />}
          accentColor="border-l-accent-primary"
          extra={<MtdSparkline summaries={mtdSummaries} />}
        />
      </div>
    </div>
  );
}
