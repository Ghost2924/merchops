import { DataProvider } from './provider';
import { DailySummary } from './types';
import { getRecentSummaries, getTodaySummary } from '../db/queries';

/**
 * TursoDataProvider — queries Turso (libSQL) directly.
 *
 * migrate() is intentionally NOT called here. Schema migrations must be run
 * as a one-time build/deploy step via `node scripts/migrate.mjs` or the
 * Turso CLI against schema.sql. Running migrate() on every cold start causes
 * unnecessary latency in serverless environments where the module-level
 * `_migrated` guard resets on each new function instance.
 */
export class TursoDataProvider implements DataProvider {
  async getRecentSummaries(days: number): Promise<DailySummary[]> {
    return getRecentSummaries(days);
  }

  async getTodaySummary(): Promise<DailySummary | null> {
    return getTodaySummary();
  }
}
