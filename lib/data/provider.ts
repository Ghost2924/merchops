import { DailySummary } from './types';
import { getRecentSummaries, getTodaySummary } from '../db/queries';

export interface DataProvider {
  getRecentSummaries(days: number): Promise<DailySummary[]>;
  getTodaySummary(): Promise<DailySummary | null>;
}

class TursoDataProvider implements DataProvider {
  async getRecentSummaries(days: number): Promise<DailySummary[]> {
    return getRecentSummaries(days);
  }
  async getTodaySummary(): Promise<DailySummary | null> {
    return getTodaySummary();
  }
}

export function getDataProvider(): DataProvider {
  if (process.env.NEXT_PUBLIC_USE_MOCK_DATA === 'true') {
    const { MockDataProvider } = require('./mock');
    return new MockDataProvider();
  }
  return new TursoDataProvider();
}
