import { resolveServerOrgId } from '@/lib/auth/serverOrg';
import { unstable_cache } from 'next/cache';
import { getDataProvider } from '@/lib/data/provider';
import { buildVolatilityEntries } from '@/lib/volatility';
import {
  getInventoryMap,
  getUnmappedSkus,
  getPhysicalSummaries,
  buildMappingLookup,
  getTodayInTz,
  getNetProfitSummary,
  PhysicalDailySummary,
} from '@/lib/db/queries';
import { DailySummary } from '@/lib/data/types';
import KpiGrid from '@/components/kpi/KpiGrid';
import ChartContainer from '@/components/charts/ChartContainer';
import TopSellingTable from '@/components/inventory/TopSellingTable';
import DailyOrdersTable from '@/components/inventory/DailyOrdersTable';
import VolatilityMonitor from '@/components/inventory/VolatilityMonitor';
import SkuRevenueSearch from '@/components/revenue/SkuRevenueSearch';
import CompactRevenuePanel from '@/components/revenue/CompactRevenuePanel';
import ProfitBreakdownPanel from '@/components/revenue/ProfitBreakdownPanel';
import DashboardTabs from '@/components/DashboardTabs';
import HistoricalOrdersPanel from '@/components/inventory/HistoricalOrdersPanel';
import Link from 'next/link';

// Cache dashboard reads under the "dashboard-data" tag.
// Served from cache on normal navigation; revalidated after each sync via
// revalidateTag("dashboard-data") in lib/sync/runSync.ts.
//
// NOTE: unstable_cache serializes via JSON, so Maps must be returned as
// plain arrays and reconstructed after the cache call.
const getCachedDashboardData = unstable_cache(
  async (isMock: boolean) => {
    const provider = getDataProvider();
    const todayStr = getTodayInTz();

    const [summaries, inventoryMapRaw, unmappedSkus, physicalSummaries, skuMappingRaw] =
      await Promise.all([
        provider.getRecentSummaries(90),
        isMock ? Promise.resolve([] as [string, number][]) : getInventoryMap().then((m) => [...m.entries()] as [string, number][]),
        isMock ? Promise.resolve([] as { raw_storefront_sku: string; last_seen_at: string }[]) : getUnmappedSkus(),
        isMock ? Promise.resolve([] as PhysicalDailySummary[]) : getPhysicalSummaries(30),
        isMock ? Promise.resolve([] as [string, string][]) : buildMappingLookup().then((m) => [...m.entries()] as [string, string][]),
      ]);

    let todayNetProfit: { revenue: number; cogs: number; marketing_spend: number; net_profit: number } | null = null;
    if (!isMock) {
      const profitRows = await getNetProfitSummary(todayStr, todayStr);
      if (profitRows.length > 0) todayNetProfit = profitRows[0];
    }

    return { summaries, inventoryMapRaw, unmappedSkus, physicalSummaries, skuMappingRaw, todayNetProfit };
  },
  ['dashboard-data'],
  { tags: ['dashboard-data'], revalidate: 3600 }
);

export default async function DashboardPage() {
  const orgId = await resolveServerOrgId();
  if (!orgId) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-sm text-gray-500 dark:text-text-secondary">
          No active workspace. Select one from the header switcher.
        </p>
      </main>
    );
  }

  const isMock = process.env.NEXT_PUBLIC_USE_MOCK_DATA === 'true';

  let summaries: DailySummary[] = [];
  let inventoryMap: Map<string, number> = new Map();
  let unmappedSkus: { raw_storefront_sku: string; last_seen_at: string }[] = [];
  let physicalSummaries: PhysicalDailySummary[] = [];
  let skuMappingLookup: Map<string, string> = new Map();
  let apiError: string | null = null;
  let todayNetProfit: { revenue: number; cogs: number; marketing_spend: number; net_profit: number } | null = null;

  try {
    const data = await getCachedDashboardData(isMock);
    summaries = data.summaries;
    inventoryMap = new Map(data.inventoryMapRaw);
    unmappedSkus = data.unmappedSkus;
    physicalSummaries = data.physicalSummaries;
    skuMappingLookup = new Map(data.skuMappingRaw);
    todayNetProfit = data.todayNetProfit;
  } catch (err) {
    apiError = err instanceof Error ? err.message : 'Unknown error';
    console.error('[DashboardPage] Data fetch failed:', apiError);
  }

  // Derive today's summary by matching the actual today date string
  const todayStr = getTodayInTz();
  const todaySummary = summaries.find((s) => s.date === todayStr) ?? null;

  // Derive today's physical summary from physicalSummaries array
  const todayPhysicalSummary = physicalSummaries.find((s) => s.date === todayStr) ?? null;

  const weeklySummaries = summaries.slice(-7);
  const weeklyPhysicalSummaries = physicalSummaries.slice(-7);
  const volatilityEntries = buildVolatilityEntries(summaries, inventoryMap, skuMappingLookup);

  const today = new Date();
  const currentMonthPrefix = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const dayOfMonth = today.getDate();
  const priorMonthDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const priorMonthPrefix = `${priorMonthDate.getFullYear()}-${String(priorMonthDate.getMonth() + 1).padStart(2, '0')}`;

  const mtdSummaries = summaries.filter((s) => s.date.startsWith(currentMonthPrefix));
  const priorMtdSummaries = summaries.filter((s) => {
    if (!s.date.startsWith(priorMonthPrefix)) return false;
    const day = parseInt(s.date.slice(8), 10);
    return day <= dayOfMonth;
  });

  const businessTz = process.env.BUSINESS_TIMEZONE ?? 'America/Los_Angeles';
  const todayFormatted = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: businessTz,
  }).format(today);

  return (
    <main className="min-h-screen">
      {/* API error banner */}
      {apiError && (
        <div className="bg-red-950 border-b border-red-800 px-6 py-3">
          <div className="max-w-7xl mx-auto flex items-center gap-2 text-sm text-red-300">
            <span className="font-semibold">⚠ Teapplix API unavailable</span>
            <span className="text-red-400">— {apiError}. Data will refresh on next sync.</span>
          </div>
        </div>
      )}

      {/* Unmapped SKU banner */}
      {unmappedSkus.length > 0 && (
        <div className="bg-amber-950 border-b border-amber-800 px-6 py-3">
          <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2 text-sm text-amber-200">
              <span className="font-semibold">⚠</span>
              <span>
                <span className="inline-flex items-center gap-1 bg-amber-900 text-amber-200 text-xs font-bold px-2 py-0.5 rounded-full mr-1">
                  {unmappedSkus.length} SKUs
                </span>
                need mapping — inventory matching paused
              </span>
            </div>
            <Link
              href="/mappings"
              className="text-xs font-semibold text-amber-300 hover:text-amber-100 transition-colors"
            >
              → Fix in Mappings
            </Link>
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Page header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-text-primary">Dashboard</h1>
            <p className="text-sm text-gray-400 dark:text-text-muted mt-0.5">{todayFormatted}</p>
          </div>
        </div>

        {/* KPI Cards */}
        <section>
          <h2 className="text-xs font-semibold text-gray-400 dark:text-text-muted uppercase tracking-widest mb-3">
            Today&apos;s Performance
          </h2>
          <KpiGrid
            todaySummary={todaySummary}
            mtdSummaries={mtdSummaries}
            priorMtdSummaries={priorMtdSummaries}
            volatilityEntries={volatilityEntries}
            todayNetProfit={todayNetProfit}
          />
        </section>

        {/* Dashboard Tabs Wrapper */}
        <DashboardTabs
          salesTab={
            <>
              {/* Charts */}
              <section>
                <h2 className="text-xs font-semibold text-gray-400 dark:text-text-muted uppercase tracking-widest mb-3">
                  Trends
                </h2>
                <ChartContainer summaries={summaries} defaultPeriod={7} />
              </section>

              {/* Revenue Breakdown */}
              <section>
                <h2 className="text-xs font-semibold text-gray-400 dark:text-text-muted uppercase tracking-widest mb-3">
                  Revenue Breakdown
                </h2>
                <CompactRevenuePanel summaries={summaries} todaySummary={todaySummary} />
              </section>

              {/* Profit Breakdown */}
              <section>
                <h2 className="text-xs font-semibold text-gray-400 dark:text-text-muted uppercase tracking-widest mb-3">
                  Profit & Cost Breakdown
                </h2>
                <ProfitBreakdownPanel />
              </section>
            </>
          }
          ordersTab={
            <>
              {/* Today's Orders */}
              <section>
                <h2 className="text-xs font-semibold text-gray-400 dark:text-text-muted uppercase tracking-widest mb-3">
                  Today&apos;s Orders by SKU
                </h2>
                <DailyOrdersTable
                  todaySummary={todaySummary}
                  todayPhysicalSummary={todayPhysicalSummary}
                  skuMappingLookup={skuMappingLookup}
                />
              </section>

              {/* Historical Orders */}
              <section>
                <h2 className="text-xs font-semibold text-gray-400 dark:text-text-muted uppercase tracking-widest mb-3">
                  Past 30 Days
                </h2>
                <HistoricalOrdersPanel
                  summaries={summaries}
                  skuMappingLookup={skuMappingLookup}
                  todayStr={todayStr}
                  physicalSummaries={physicalSummaries}
                />
              </section>

              {/* SKU Revenue Search */}
              <section>
                <h2 className="text-xs font-semibold text-gray-400 dark:text-text-muted uppercase tracking-widest mb-3">
                  SKU Revenue Lookup
                </h2>
                <SkuRevenueSearch />
              </section>
            </>
          }
          inventoryTab={
            <>
              {/* Inventory Intelligence */}
              <section>
                <h2 className="text-xs font-semibold text-gray-400 dark:text-text-muted uppercase tracking-widest mb-3">
                  Inventory Intelligence
                </h2>
                <TopSellingTable
                  todaySummary={todaySummary}
                  weeklySummaries={weeklySummaries}
                  todayPhysicalSummary={todayPhysicalSummary}
                  weeklyPhysicalSummaries={weeklyPhysicalSummaries}
                  inventoryMap={inventoryMap}
                  skuMappingLookup={skuMappingLookup}
                  volatilityEntries={volatilityEntries}
                  limit={20}
                />
              </section>

              {/* Sales Velocity Monitor */}
              <section>
                <h2 className="text-xs font-semibold text-gray-400 dark:text-text-muted uppercase tracking-widest mb-3">
                  Sales Velocity Monitor
                </h2>
                <VolatilityMonitor entries={volatilityEntries} />
              </section>
            </>
          }
        />
      </div>
    </main>
  );
}
