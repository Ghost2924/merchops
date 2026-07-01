/**
 * lib/db/sync-status.ts
 *
 * Shared helper for writing sync progress to the sync_status table.
 * Used by manual-sync route and runVendorSync.
 */

import { getDb } from './turso';

export async function writeSyncStatus(
  phase: string,
  detail: string | null,
  done: boolean,
  error?: string,
): Promise<void> {
  try {
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO sync_status (id, phase, detail, done, error, started_at, updated_at)
            VALUES ('current', ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              phase      = excluded.phase,
              detail     = excluded.detail,
              done       = excluded.done,
              error      = excluded.error,
              updated_at = datetime('now')`,
      args: [phase, detail ?? null, done ? 1 : 0, error ?? null],
    });
  } catch {
    // Non-fatal — status updates must never break sync
  }
}
