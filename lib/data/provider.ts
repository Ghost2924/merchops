import { DailySummary } from './types';

export interface DataProvider {
  /**
   * Returns daily summaries for the trailing `days` calendar days,
   * sorted ascending by date. Returns fewer records if fewer are available.
   */
  getRecentSummaries(days: number): Promise<DailySummary[]>;

  /**
   * Returns the summary for today's date, or null if not yet available.
   */
  getTodaySummary(): Promise<DailySummary | null>;
}

export function getDataProvider(): DataProvider {
  if (process.env.NEXT_PUBLIC_USE_MOCK_DATA === 'true') {
    const { MockDataProvider } = require('./mock');
    return new MockDataProvider();
  }
  // Live: query Turso DB
  const { TursoDataProvider } = require('./turso-provider');
  return new TursoDataProvider();
}
