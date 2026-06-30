import { DailySummary, SkuRecord } from './types';
import { DataProvider } from './provider';

// Fixed 20-SKU catalog
const SKU_CATALOG = [
  'TEA-GREEN-100', 'TEA-BLACK-100', 'TEA-OOLONG-50', 'TEA-WHITE-50',
  'TEA-HERBAL-75', 'TEA-CHAI-100', 'TEA-MATCHA-30', 'TEA-ROOIBOS-75',
  'TEA-PEPPERMINT-50', 'TEA-CHAMOMILE-50', 'TEA-EARL-GREY-100',
  'TEA-JASMINE-50', 'TEA-GINGER-75', 'TEA-TURMERIC-30', 'TEA-HIBISCUS-50',
  'TEAPOT-CERAMIC-1', 'TEAPOT-GLASS-1', 'INFUSER-BALL-1', 'INFUSER-BASKET-1',
  'GIFT-SET-PREMIUM-1',
];

// Seeded pseudo-random number generator (LCG) for stable values across renders
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function generateMockSummaries(days: number): DailySummary[] {
  const summaries: DailySummary[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);

    // Seed based on date string for stability
    const seed = dateStr.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const rand = seededRandom(seed);

    const orderCount = Math.floor(rand() * 151) + 50; // 50–200
    const aov = rand() * 65 + 15; // $15–$80

    // Pick 8–15 SKUs for this day
    const skuCount = Math.floor(rand() * 8) + 8;
    const shuffled = [...SKU_CATALOG].sort(() => rand() - 0.5);
    const daySkus = shuffled.slice(0, skuCount);

    const skus: SkuRecord[] = daySkus.map((sku) => {
      const qty = Math.floor(rand() * 20) + 1;
      const unitPrice = rand() * 50 + 10;
      const revenue = qty * unitPrice;
      return {
        sku,
        quantitySold: qty,
        totalRevenue: Math.round(revenue * 100) / 100,
        unitPrice: Math.round(unitPrice * 100) / 100,
      };
    });

    const totalRevenue = Math.round(orderCount * aov * 100) / 100;

    summaries.push({
      date: dateStr,
      orderCount,
      totalRevenue,
      aov: Math.round(aov * 100) / 100,
      skus,
    });
  }

  return summaries;
}

// 12 years = 4380 days — generate full history once, slice on demand
const MOCK_HISTORY_DAYS = 4380;

export class MockDataProvider implements DataProvider {
  private summaries: DailySummary[];

  constructor() {
    this.summaries = generateMockSummaries(MOCK_HISTORY_DAYS);
  }

  async getRecentSummaries(days: number): Promise<DailySummary[]> {
    const sorted = [...this.summaries].sort((a, b) => a.date.localeCompare(b.date));
    return sorted.slice(-days);
  }

  async getTodaySummary(): Promise<DailySummary | null> {
    const today = new Date().toISOString().slice(0, 10);
    return this.summaries.find((s) => s.date === today) ?? null;
  }
}
