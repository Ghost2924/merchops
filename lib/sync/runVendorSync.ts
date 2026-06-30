/**
 * runVendorSync — core logic for fetching and upserting Amazon Vendor ARA data.
 * Extracted from /api/vendor-sync/route.ts so it can be called from the cron
 * endpoint (/api/vendor-sync) without violating Next.js route file export rules.
 *
 * Pulls three SP-API vendor reports and upserts into:
 *   vendor_ara_metrics       (sales + margin reports)
 *   vendor_inventory_health  (inventory report)
 *
 * Date window: ARA data lags ~3-4 days. DAY granularity capped at 15 days.
 *   dataEndTime   = today minus 4 days
 *   dataStartTime = dataEndTime minus 13 days  (14-day window, inclusive)
 *
 * Re-runs are idempotent — all upserts use ON CONFLICT DO UPDATE.
 * Per-report errors (FATAL, access-denied) are caught and logged —
 * they never propagate to the caller.
 *
 * Deduplication / resume (vendor_pending_reports):
 *   Before requesting a new report, check the table for a recent
 *   IN_QUEUE or IN_PROGRESS reportId for that type. If one exists and
 *   its date window matches the current window, resume polling THAT one.
 *   If poll times out, persist the reportId so the next sync resumes it.
 *   On DONE → clear row. On FATAL/CANCELLED → clear row (allow fresh retry).
 *
 * Parallelism:
 *   All 3 reports are requested in parallel (Promise.all). Each is then
 *   polled independently. Amazon throttles polling, not report creation.
 *   POLL_MAX_ATTEMPTS = 15 (~90s max per report). On timeout → TIMEOUT_RESUMED,
 *   cron picks up on next run via vendor_pending_reports.
 */

import { revalidateTag } from 'next/cache';
import { getDb, migrate } from '@/lib/db/turso';
import { runWithOrg, getOrgContext } from '@/lib/db/context';
import { getDateNDaysAgoInTz } from '@/lib/db/queries';
import {
  requestReport,
  waitForReport,
  downloadReportDocument,
  VendorReportType,
  ReportOptions,
} from '@/lib/spapi/vendor';

// ---------------------------------------------------------------------------
// Types for parsed report rows
// ---------------------------------------------------------------------------

interface AraMetricsRow {
  asin: string;
  period_start: string;
  period_end: string;
  period_type: string;
  shipped_revenue?: number;
  shipped_cogs?: number;
  ordered_units?: number;
  shipped_units?: number;
  customer_returns?: number;
  net_ppm?: number;
  sales_discount?: number;
  currency: string;
}

interface InventoryHealthRow {
  asin: string;
  snapshot_date: string;
  roos_percent?: number;
  sellable_on_hand_units?: number;
  open_po_units?: number;
  unfilled_customer_ordered_units?: number;
}

// ---------------------------------------------------------------------------
// Report parser helpers
// ---------------------------------------------------------------------------

function extractAsinRows(
  raw: string,
  arrayKey: string
): { rows: Record<string, unknown>[]; arrayKey: string; totalCount: number } {
  const rows: Record<string, unknown>[] = [];
  const trimmed = raw.trim();
  const candidates: Record<string, unknown>[] = [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        candidates.push(...parsed);
      } else {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // fall through to ND-JSON
    }
  }

  if (candidates.length === 0) {
    for (const line of trimmed.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try {
        candidates.push(JSON.parse(l) as Record<string, unknown>);
      } catch {
        // skip malformed line
      }
    }
  }

  for (const obj of candidates) {
    const arr = obj[arrayKey];
    if (Array.isArray(arr)) {
      rows.push(...(arr as Record<string, unknown>[]));
    }
  }

  return { rows, arrayKey, totalCount: rows.length };
}

function extractAmount(val: unknown): number | undefined {
  if (val == null) return undefined;
  if (typeof val === 'object' && val !== null && 'amount' in val) {
    const n = Number((val as Record<string, unknown>).amount);
    return isFinite(n) ? n : undefined;
  }
  const n = Number(val);
  return isFinite(n) ? n : undefined;
}

function extractInt(val: unknown): number | undefined {
  if (val == null) return undefined;
  const n = Number(val);
  return isFinite(n) ? Math.round(n) : undefined;
}

function extractCurrency(val: unknown): string {
  if (typeof val === 'object' && val !== null && 'currencyCode' in val) {
    return String((val as Record<string, unknown>).currencyCode) || 'USD';
  }
  return 'USD';
}

function parseSalesReport(raw: string): AraMetricsRow[] {
  const { rows, arrayKey, totalCount } = extractAsinRows(raw, 'salesByAsin');
  console.log(`[vendor-parser] GET_VENDOR_SALES_REPORT arrayKey=${arrayKey} arrayLength=${totalCount}`);
  if (rows.length > 0) console.log(`[vendor-parser] first row: ${JSON.stringify(rows[0])}`);

  return rows.map((r) => ({
    asin:             String(r.asin ?? r.ASIN ?? ''),
    period_start:     String(r.startDate ?? r.dataStartTime ?? ''),
    period_end:       String(r.endDate ?? r.dataEndTime ?? ''),
    period_type:      'DAY',
    shipped_revenue:  extractAmount(r.shippedRevenue),
    shipped_cogs:     extractAmount(r.shippedCogs),
    ordered_units:    extractInt(r.orderedUnits),
    shipped_units:    extractInt(r.shippedUnits),
    customer_returns: extractInt(r.customerReturns),
    currency:         extractCurrency(r.shippedRevenue) || extractCurrency(r.shippedCogs) || 'USD',
  })).filter((r) => r.asin);
}

function parseMarginReport(raw: string): AraMetricsRow[] {
  const { rows, arrayKey, totalCount } = extractAsinRows(raw, 'netPureProductMarginByAsin');
  console.log(`[vendor-parser] GET_VENDOR_NET_PURE_PRODUCT_MARGIN_REPORT arrayKey=${arrayKey} arrayLength=${totalCount}`);
  if (rows.length > 0) console.log(`[vendor-parser] first row: ${JSON.stringify(rows[0])}`);

  return rows.map((r) => {
    const rawPpm = extractAmount(r.netPureProductMargin ?? r.netPpm ?? r.netPPM);
    const net_ppm = rawPpm != null ? rawPpm * 100 : undefined;
    return {
      asin:           String(r.asin ?? r.ASIN ?? ''),
      period_start:   String(r.startDate ?? r.dataStartTime ?? ''),
      period_end:     String(r.endDate ?? r.dataEndTime ?? ''),
      period_type:    'DAY',
      net_ppm,
      sales_discount: extractAmount((r.salesDiscount as Record<string,unknown>)?.amount !== undefined ? r.salesDiscount : r.salesDiscount),
      currency:       extractCurrency(r.netPureProductMargin) || 'USD',
    };
  }).filter((r) => r.asin);
}

function parseInventoryReport(raw: string, distributorView: 'SOURCING' | 'MANUFACTURING' = 'SOURCING'): InventoryHealthRow[] {
  const { rows, arrayKey, totalCount } = extractAsinRows(raw, 'inventoryByAsin');
  console.log(`[vendor-parser] GET_VENDOR_INVENTORY_REPORT arrayKey=${arrayKey} arrayLength=${totalCount} view=${distributorView}`);
  if (rows.length > 0) console.log(`[vendor-parser] first row: ${JSON.stringify(rows[0])}`);

  const oosField = distributorView === 'SOURCING'
    ? 'sourceableProductOutOfStockRate'
    : 'procurableProductOutOfStockRate';

  return rows.map((r) => ({
    asin:                            String(r.asin ?? r.ASIN ?? ''),
    snapshot_date:                   String(r.snapshotDate ?? r.startDate ?? r.dataStartTime ?? ''),
    roos_percent:                    extractAmount(r[oosField]),
    sellable_on_hand_units:          extractInt(r.sellableOnHandInventoryUnits ?? r.sellableOnHandUnits),
    open_po_units:                   extractInt(r.openPurchaseOrderUnits ?? r.openPoUnits),
    unfilled_customer_ordered_units: extractInt(r.unfilledCustomerOrderedUnits),
  })).filter((r) => r.asin);
}

// ---------------------------------------------------------------------------
// DB upserts — single db.batch() call per chunk (one round-trip)
// ---------------------------------------------------------------------------

async function upsertAraMetrics(rows: AraMetricsRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  const BATCH = 100;
  let count = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO vendor_ara_metrics
                (asin, period_start, period_end, period_type,
                 shipped_revenue, shipped_cogs, ordered_units, shipped_units, customer_returns,
                 net_ppm, sales_discount, currency, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(asin, period_start, period_end, period_type) DO UPDATE SET
                shipped_revenue   = COALESCE(excluded.shipped_revenue,   shipped_revenue),
                shipped_cogs      = COALESCE(excluded.shipped_cogs,      shipped_cogs),
                ordered_units     = COALESCE(excluded.ordered_units,     ordered_units),
                shipped_units     = COALESCE(excluded.shipped_units,     shipped_units),
                customer_returns  = COALESCE(excluded.customer_returns,  customer_returns),
                net_ppm           = COALESCE(excluded.net_ppm,           net_ppm),
                sales_discount    = COALESCE(excluded.sales_discount,    sales_discount),
                currency          = excluded.currency,
                updated_at        = datetime('now')`,
        args: [
          r.asin, r.period_start, r.period_end, r.period_type,
          r.shipped_revenue ?? null, r.shipped_cogs ?? null,
          r.ordered_units ?? null, r.shipped_units ?? null, r.customer_returns ?? null,
          r.net_ppm ?? null, r.sales_discount ?? null, r.currency,
        ],
      }))
    );
    count += chunk.length;
  }
  return count;
}

async function upsertInventoryHealth(rows: InventoryHealthRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  const BATCH = 100;
  let count = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO vendor_inventory_health
                (asin, snapshot_date, roos_percent,
                 sellable_on_hand_units, open_po_units, unfilled_customer_ordered_units,
                 updated_at)
              VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(asin, snapshot_date) DO UPDATE SET
                roos_percent                    = COALESCE(excluded.roos_percent,                    roos_percent),
                sellable_on_hand_units          = COALESCE(excluded.sellable_on_hand_units,          sellable_on_hand_units),
                open_po_units                   = COALESCE(excluded.open_po_units,                   open_po_units),
                unfilled_customer_ordered_units = COALESCE(excluded.unfilled_customer_ordered_units, unfilled_customer_ordered_units),
                updated_at                      = datetime('now')`,
        args: [
          r.asin, r.snapshot_date,
          r.roos_percent ?? null,
          r.sellable_on_hand_units ?? null,
          r.open_po_units ?? null,
          r.unfilled_customer_ordered_units ?? null,
        ],
      }))
    );
    count += chunk.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// sync_status helpers — written during sync so /api/sync-status can poll
// ---------------------------------------------------------------------------

async function writeSyncStatus(
  phase: string,
  detail: string | null,
  done: boolean,
  error?: string
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
  } catch (e) {
    // Non-fatal — status updates must never break sync
    console.warn('[vendor-sync] writeSyncStatus failed:', e);
  }
}

// ---------------------------------------------------------------------------
// vendor_pending_reports helpers — deduplication / resume
// ---------------------------------------------------------------------------

interface PendingReportRow {
  report_type: string;
  report_id: string;
  status: string;
  data_start: string | null;
  data_end: string | null;
}

async function getPendingReport(reportType: string): Promise<PendingReportRow | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT report_type, report_id, status, data_start, data_end
          FROM vendor_pending_reports WHERE report_type = ?`,
    args: [reportType],
  });
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  return {
    report_type: r.report_type as string,
    report_id:   r.report_id   as string,
    status:      r.status      as string,
    data_start:  r.data_start  as string | null,
    data_end:    r.data_end    as string | null,
  };
}

async function upsertPendingReport(
  reportType: string,
  reportId: string,
  status: string,
  dataStart: string,
  dataEnd: string
): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO vendor_pending_reports
            (report_type, report_id, status, data_start, data_end, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(report_type) DO UPDATE SET
            report_id  = excluded.report_id,
            status     = excluded.status,
            data_start = excluded.data_start,
            data_end   = excluded.data_end,
            updated_at = datetime('now')`,
    args: [reportType, reportId, status, dataStart, dataEnd],
  });
}

async function clearPendingReport(reportType: string): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `DELETE FROM vendor_pending_reports WHERE report_type = ?`,
    args: [reportType],
  });
}

// ---------------------------------------------------------------------------
// Per-report options
// ---------------------------------------------------------------------------

const REPORT_OPTIONS: Record<string, ReportOptions> = {
  GET_VENDOR_SALES_REPORT: {
    distributorView: 'MANUFACTURING',
    sellingProgram: 'RETAIL',
    reportPeriod: 'DAY',
  },
  GET_VENDOR_NET_PURE_PRODUCT_MARGIN_REPORT: {
    reportPeriod: 'DAY',
  },
  GET_VENDOR_INVENTORY_REPORT: {
    distributorView: 'SOURCING',
    sellingProgram: 'RETAIL',
    reportPeriod: 'DAY',
  },
};

// ---------------------------------------------------------------------------
// Per-report runner
// ---------------------------------------------------------------------------

type ReportResult =
  | { ok: true;  reportType: VendorReportType; rowsUpserted: number }
  | { ok: false; reportType: VendorReportType; status?: string; error: string };

// Reduced from 50 → 15 attempts (~90s max per report).
// On timeout the reportId is persisted as IN_PROGRESS via vendor_pending_reports
// so the next cron run resumes it rather than creating a new report.
const POLL_MAX_ATTEMPTS = 15;
const POLL_INTERVAL_MS  = 6_000;

async function runReport(
  reportType: VendorReportType,
  dataStartTime: string,
  dataEndTime: string
): Promise<ReportResult> {
  const reportOptions: ReportOptions = REPORT_OPTIONS[reportType] ?? {};

  // ── Step 1: check for an existing IN_QUEUE / IN_PROGRESS report ──────────
  let reportId: string | undefined;

  try {
    const pending = await getPendingReport(reportType);
    if (
      pending &&
      (pending.status === 'IN_QUEUE' || pending.status === 'IN_PROGRESS') &&
      pending.data_start === dataStartTime &&
      pending.data_end   === dataEndTime
    ) {
      reportId = pending.report_id;
      console.log(
        `[vendor-sync] resuming ${reportType} → reportId=${reportId} status=${pending.status}`
      );
    } else if (pending) {
      console.log(
        `[vendor-sync] ignoring stale pending ${reportType}: reportId=${pending.report_id} ` +
        `status=${pending.status} (current window: ${dataStartTime}→${dataEndTime})`
      );
    }
  } catch (dbErr) {
    console.warn(`[vendor-sync] could not read vendor_pending_reports: ${dbErr}`);
  }

  // ── Step 2: request new report if no resumable one ───────────────────────
  if (!reportId) {
    console.log(
      `[vendor-sync] requesting ${reportType} | reportOptions=${JSON.stringify(reportOptions)} ` +
      `| dataStartTime=${dataStartTime} | dataEndTime=${dataEndTime}`
    );
    try {
      const { reportId: id } = await requestReport(reportType, reportOptions, dataStartTime, dataEndTime);
      reportId = id;
      console.log(`[vendor-sync] requested ${reportType} → reportId=${reportId}`);
      await upsertPendingReport(reportType, reportId, 'IN_QUEUE', dataStartTime, dataEndTime);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isAccessDenied =
        /403|access.?denied|not.*approved|unauthorized|insufficient.*access/i.test(message);
      if (isAccessDenied) {
        console.warn(`[vendor-sync] ${reportType}: access not approved — skipping. (${message})`);
        return { ok: false, reportType, status: 'ACCESS_DENIED', error: message };
      }
      console.error(`[vendor-sync] ${reportType} requestReport failed: ${message}`);
      return { ok: false, reportType, error: message };
    }
  }

  // ── Step 3: poll until DONE, timeout, or terminal ────────────────────────
  try {
    await upsertPendingReport(reportType, reportId, 'IN_PROGRESS', dataStartTime, dataEndTime);
    await writeSyncStatus(`vendor:polling`, reportType, false);

    const statusResp = await waitForReport(reportId, POLL_MAX_ATTEMPTS, POLL_INTERVAL_MS);

    await clearPendingReport(reportType).catch(() => {});
    await writeSyncStatus(`vendor:downloading`, reportType, false);

    const raw = await downloadReportDocument(statusResp.reportDocumentId!);
    let rowsUpserted = 0;

    if (reportType === 'GET_VENDOR_SALES_REPORT') {
      const rows = parseSalesReport(raw);
      rowsUpserted = await upsertAraMetrics(rows);
      console.log(`[vendor-sync] FINAL ${reportType}: rows parsed=${rows.length}, upserted=${rowsUpserted}`);
    } else if (reportType === 'GET_VENDOR_NET_PURE_PRODUCT_MARGIN_REPORT') {
      const rows = parseMarginReport(raw);
      rowsUpserted = await upsertAraMetrics(rows);
      console.log(`[vendor-sync] FINAL ${reportType}: rows parsed=${rows.length}, upserted=${rowsUpserted}`);
    } else if (reportType === 'GET_VENDOR_INVENTORY_REPORT') {
      const invView = (reportOptions.distributorView ?? 'SOURCING') as 'SOURCING' | 'MANUFACTURING';
      const rows = parseInventoryReport(raw, invView);
      rowsUpserted = await upsertInventoryHealth(rows);
      console.log(`[vendor-sync] FINAL ${reportType}: rows parsed=${rows.length}, upserted=${rowsUpserted}`);
    }

    return { ok: true, reportType, rowsUpserted };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    const isAccessDenied =
      /403|access.?denied|not.*approved|unauthorized|insufficient.*access/i.test(message);
    if (isAccessDenied) {
      console.warn(`[vendor-sync] ${reportType}: access not approved — skipping. (${message})`);
      await clearPendingReport(reportType).catch(() => {});
      return { ok: false, reportType, status: 'ACCESS_DENIED', error: message };
    }

    const terminalMatch = message.match(/status (FATAL|CANCELLED)/);
    if (terminalMatch) {
      const status = terminalMatch[1];
      console.error(`[vendor-sync] ${reportType} ended with ${status}:\n${message}`);
      await clearPendingReport(reportType).catch(() => {});
      return { ok: false, reportType, status, error: message };
    }

    // Timeout: reportId persisted as IN_PROGRESS above — next cron resumes it
    if (/did not complete after/i.test(message)) {
      console.warn(
        `[vendor-sync] ${reportType} timed out — reportId=${reportId} persisted, will resume next sync`
      );
      return { ok: false, reportType, status: 'TIMEOUT_RESUMED', error: message };
    }

    console.error(`[vendor-sync] ${reportType} failed: ${message}`);
    await clearPendingReport(reportType).catch(() => {});
    return { ok: false, reportType, error: message };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface VendorSyncResult {
  ok: boolean;
  dateWindow: { dataStartTime: string; dataEndTime: string };
  reports: Array<
    | { reportType: VendorReportType; rowsUpserted: number }
    | { reportType: VendorReportType; status: string; error: string }
  >;
  successCount: number;
  failureCount: number;
}

export async function runVendorSync(options?: { organizationId?: string }): Promise<VendorSyncResult> {
  const orgId = options?.organizationId ?? getOrgContext().orgId;
  if (orgId) {
    return runWithOrg(orgId, false, () => runVendorSyncInternal());
  } else {
    return runVendorSyncInternal();
  }
}

async function runVendorSyncInternal(): Promise<VendorSyncResult> {
  await migrate();

  const dataEndTime = getDateNDaysAgoInTz(4);
  // Rolling window: pull trailing 90 days (ARA DAY granularity supports up to ~90 days per request).
  // This ensures 7d / 30d / 90d period selectors show meaningfully different data.
  // 1y will still show "partial" badge since ARA doesn't support >90d DAY granularity per request —
  // run the backfill script (scripts/backfill-vendor-ara.mjs) to populate older history.
  const dataStartTimeDate = new Date(dataEndTime);
  dataStartTimeDate.setDate(dataStartTimeDate.getDate() - 89);
  const dataStartTime = dataStartTimeDate.toISOString().slice(0, 10);

  console.log(`[vendor-sync] date window: ${dataStartTime} → ${dataEndTime}`);

  await writeSyncStatus('vendor:starting', `window ${dataStartTime}→${dataEndTime}`, false);

  const REPORT_TYPES: VendorReportType[] = [
    'GET_VENDOR_SALES_REPORT',
    'GET_VENDOR_NET_PURE_PRODUCT_MARGIN_REPORT',
    'GET_VENDOR_INVENTORY_REPORT',
  ];

  // Run all 3 report requests in parallel — Amazon throttles polling, not creation.
  // Each report polls independently up to POLL_MAX_ATTEMPTS (15 × 6s = 90s).
  const results = await Promise.all(
    REPORT_TYPES.map((reportType) => runReport(reportType, dataStartTime, dataEndTime))
  );

  const successCount = results.filter((r) => r.ok).length;
  const failureCount = results.filter((r) => !r.ok).length;

  revalidateTag('dashboard-data');

  const summary: VendorSyncResult = {
    ok: true,
    dateWindow: { dataStartTime, dataEndTime },
    reports: results.map((r) =>
      r.ok
        ? { reportType: r.reportType, rowsUpserted: r.rowsUpserted }
        : {
            reportType: r.reportType,
            status: (r as Extract<ReportResult, { ok: false }>).status ?? 'ERROR',
            error:  (r as Extract<ReportResult, { ok: false }>).error,
          }
    ),
    successCount,
    failureCount,
  };

  await writeSyncStatus('vendor:done', `${successCount} ok, ${failureCount} failed`, true);
  console.log('[vendor-sync] complete:', JSON.stringify(summary));
  return summary;
}
