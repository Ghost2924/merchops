/**
 * SP-API Vendor Reports client
 *
 * Handles the full create → poll IN_PROGRESS → download flow for ARA reports.
 *
 * Auth: reuses AMAZON_VENDOR_CLIENT_ID / AMAZON_VENDOR_CLIENT_SECRET /
 *       AMAZON_VENDOR_REFRESH_TOKEN from the existing LWA setup in
 *       lib/amazonVendor.ts — no credentials hardcoded here.
 *
 * Supported report types:
 *   GET_VENDOR_SALES_REPORT
 *   GET_VENDOR_NET_PURE_PRODUCT_MARGIN_REPORT
 *   GET_VENDOR_INVENTORY_REPORT
 *
 * Usage:
 *   const { reportId } = await requestReport('GET_VENDOR_SALES_REPORT', {}, '2024-01-01', '2024-01-31');
 *   const { status, reportDocumentId } = await pollReport(reportId);
 *   const rows = await downloadReportDocument(reportDocumentId!);
 */

import { getAmazonAccessToken } from '../amazonVendor';
import { gunzipSync } from 'zlib';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SP_API_BASE = 'https://sellingpartnerapi-na.amazon.com';

/** Sales report options: distributorView + sellingProgram + reportPeriod required. */
const DEFAULT_SALES_OPTIONS: ReportOptions = {
  distributorView: 'MANUFACTURING',
  sellingProgram: 'RETAIL',
  reportPeriod: 'DAY',
};

/** Inventory report options: reportPeriod + distributorView + sellingProgram required. */
const DEFAULT_INVENTORY_OPTIONS: ReportOptions = {
  distributorView: 'SOURCING',
  sellingProgram: 'RETAIL',
  reportPeriod: 'DAY',
};

// NET_PURE_PRODUCT_MARGIN requires reportPeriod but rejects distributorView/sellingProgram — handled in buildReportOptions.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VendorReportType =
  | 'GET_VENDOR_SALES_REPORT'
  | 'GET_VENDOR_NET_PURE_PRODUCT_MARGIN_REPORT'
  | 'GET_VENDOR_INVENTORY_REPORT';

export type ReportPeriod = 'DAY' | 'WEEK' | 'MONTH';
export type DistributorView = 'MANUFACTURING' | 'SOURCING';
export type SellingProgram = 'RETAIL' | 'FRESH' | 'LAUNCHPAD' | 'LOCAL_SHOPS';

export interface ReportOptions {
  /** Only for sales + margin reports. Default: 'MANUFACTURING' */
  distributorView?: DistributorView;
  /** Only for sales + margin reports. Default: 'RETAIL' */
  sellingProgram?: SellingProgram;
  /** Granularity of the report. Default: 'DAY' */
  reportPeriod?: ReportPeriod;
}

export type ReportStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'DONE' | 'FATAL' | 'CANCELLED';

export interface ReportStatusResponse {
  reportId: string;
  reportType: VendorReportType;
  dataStartTime?: string;
  dataEndTime?: string;
  processingStatus: ReportStatus;
  reportDocumentId?: string;
  createdTime: string;
}

export interface CreateReportResponse {
  reportId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build per-report reportOptions — each report type has different requirements:
 *
 *   GET_VENDOR_SALES_REPORT              → distributorView + sellingProgram + reportPeriod
 *   GET_VENDOR_INVENTORY_REPORT          → distributorView + sellingProgram + reportPeriod
 *   GET_VENDOR_NET_PURE_PRODUCT_MARGIN_REPORT → NO distributorView / sellingProgram (sends {})
 *
 * Caller overrides are merged on top of the type-specific defaults.
 */
function buildReportOptions(
  reportType: VendorReportType,
  overrides: ReportOptions
): Record<string, string> {
  let base: ReportOptions;

  if (reportType === 'GET_VENDOR_SALES_REPORT') {
    base = { ...DEFAULT_SALES_OPTIONS };
  } else if (reportType === 'GET_VENDOR_INVENTORY_REPORT') {
    base = { ...DEFAULT_INVENTORY_OPTIONS };
  } else {
    // GET_VENDOR_NET_PURE_PRODUCT_MARGIN_REPORT: reportPeriod required, but NO distributorView/sellingProgram
    base = { reportPeriod: 'DAY' };
  }

  const merged = { ...base, ...overrides };

  // SP-API wants all values as strings in reportOptions
  return Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])
  ) as Record<string, string>;
}

async function spApiRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<T> {
  const accessToken = await getAmazonAccessToken();
  const url = `${SP_API_BASE}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SP-API ${method} ${path} failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Request a vendor report.
 *
 * @param reportType  One of the three supported ARA report types.
 * @param reportOptions  Override default options (distributorView, sellingProgram, reportPeriod).
 * @param dataStartTime  ISO-8601 date string, e.g. "2024-01-01" or "2024-01-01T00:00:00Z"
 * @param dataEndTime    ISO-8601 date string (inclusive end of range).
 * @returns              Object containing the SP-API reportId.
 */
export async function requestReport(
  reportType: VendorReportType,
  reportOptions: ReportOptions = {},
  dataStartTime: string,
  dataEndTime: string
): Promise<CreateReportResponse> {
  const payload = {
    reportType,
    reportOptions: buildReportOptions(reportType, reportOptions),
    dataStartTime,
    dataEndTime,
    marketplaceIds: ['ATVPDKIKX0DER'], // US marketplace
  };

  // LOG exact createReport body so we can verify reportOptions are correct
  console.log(`[vendor] createReport payload: ${JSON.stringify(payload)}`);

  const data = await spApiRequest<{ reportId: string }>(
    'POST',
    '/reports/2021-06-30/reports',
    payload
  );

  return { reportId: data.reportId };
}

/**
 * Poll for report status. Call repeatedly (with backoff) until
 * processingStatus is 'DONE' or terminal ('FATAL' / 'CANCELLED').
 *
 * @param reportId  The reportId returned by requestReport.
 */
export async function pollReport(reportId: string): Promise<ReportStatusResponse> {
  const data = await spApiRequest<ReportStatusResponse>(
    'GET',
    `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`
  );
  return data;
}

/**
 * Download and decompress a completed report document.
 *
 * Fetches the document URL from SP-API, downloads the file (gzip or plain),
 * and returns the decompressed content as a UTF-8 string.
 *
 * @param documentId  The reportDocumentId from a DONE pollReport response.
 * @returns           Raw report content (typically newline-delimited JSON or TSV).
 */
export async function downloadReportDocument(documentId: string): Promise<string> {
  // Step 1: Get document metadata (URL + compression info)
  interface DocumentMeta {
    reportDocumentId: string;
    url: string;
    compressionAlgorithm?: 'GZIP';
  }

  const meta = await spApiRequest<DocumentMeta>(
    'GET',
    `/reports/2021-06-30/documents/${encodeURIComponent(documentId)}`
  );

  // Step 2: Download the actual file from the pre-signed S3 URL
  const fileRes = await fetch(meta.url);
  if (!fileRes.ok) {
    throw new Error(
      `Failed to download report document (${fileRes.status}): ${meta.url}`
    );
  }

  const buffer = Buffer.from(await fileRes.arrayBuffer());

  // Step 3: Decompress if needed
  if (meta.compressionAlgorithm === 'GZIP') {
    return gunzipSync(buffer).toString('utf-8');
  }

  return buffer.toString('utf-8');
}

// ---------------------------------------------------------------------------
// Convenience: poll with backoff until terminal status
// ---------------------------------------------------------------------------

/**
 * Poll reportId until status is DONE (or FATAL/CANCELLED).
 * Throws if status is FATAL or CANCELLED, or if maxAttempts exceeded.
 *
 * Logs every poll attempt: reportId, attempt #, processingStatus, elapsed seconds.
 *
 * @param reportId      The reportId to poll.
 * @param maxAttempts   Max poll iterations before throwing. Default: 50 (≈5 min at 6 s interval).
 * @param intervalMs    Base interval between polls in ms. Default: 6 000.
 */
export async function waitForReport(
  reportId: string,
  maxAttempts = 50,
  intervalMs = 6_000
): Promise<ReportStatusResponse> {
  const startMs = Date.now();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await pollReport(reportId);
    const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);

    console.log(
      `[vendor] poll attempt=${attempt + 1}/${maxAttempts} reportId=${reportId} status=${status.processingStatus} elapsed=${elapsedS}s`
    );

    if (status.processingStatus === 'DONE') {
      console.log(
        `[vendor] FINAL status=DONE reportId=${reportId} after ${elapsedS}s`
      );
      return status;
    }

    if (status.processingStatus === 'FATAL' || status.processingStatus === 'CANCELLED') {
      console.error(
        `[vendor] FINAL status=${status.processingStatus} reportId=${reportId} after ${elapsedS}s`
      );

      let errorDocBody: string | undefined;

      if (status.reportDocumentId) {
        try {
          errorDocBody = await downloadReportDocument(status.reportDocumentId);
          console.error(
            `[vendor] error document (reportDocumentId=${status.reportDocumentId}):\n${errorDocBody}`
          );
        } catch (docErr) {
          console.error(
            `[vendor] failed to fetch error document (${status.reportDocumentId}):`,
            docErr
          );
        }
      } else {
        console.error(`[vendor] no reportDocumentId in status response`);
      }

      const detail = errorDocBody ? ` | errorDocument: ${errorDocBody}` : '';
      throw new Error(
        `Report ${reportId} ended with status ${status.processingStatus}${detail}`
      );
    }

    // Still IN_QUEUE or IN_PROGRESS — wait then retry
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
  console.error(
    `[vendor] TIMEOUT reportId=${reportId} after ${maxAttempts} attempts (${elapsedS}s) — no terminal status`
  );
  throw new Error(
    `Report ${reportId} did not complete after ${maxAttempts} attempts (${elapsedS}s)`
  );
}

// ---------------------------------------------------------------------------
// Marketing Report Types — GET_PROMOTION_PERFORMANCE_REPORT
// ---------------------------------------------------------------------------

/**
 * Vendor-compatible marketing report type (Reports API v2021-06-30).
 *
 *   GET_PROMOTION_PERFORMANCE_REPORT
 *     • Covers Vendor Central promotions: Best Deal, Lightning Deal,
 *       and Price Discount.
 *     • Uses TOP-LEVEL dataStartTime / dataEndTime (standard ARA pattern).
 *     • reportOptions: no required fields; omit promotionType filter to get
 *       all types in one request.
 *     • Output: newline-delimited JSON or TSV (parser handles both).
 *     • Available to Vendor Central SP-API credentials.
 *
 * NOTE: GET_COUPON_PERFORMANCE_REPORT exists in the SP-API enum but is
 * documented as Seller Central-only. Do not use it with Vendor credentials.
 *
 * There is NO "net retail program costs" report type in the SP-API Reports
 * v2021-06-30 enumeration. Co-op and program cost data is not available
 * via the Reports API.
 */
export type MarketingReportType = 'GET_PROMOTION_PERFORMANCE_REPORT';

/** One row from GET_PROMOTION_PERFORMANCE_REPORT (Vendor), keyed per ASIN + promotion. */
export interface PromotionReportRow {
  asin: string;
  promotion_id: string;
  promotion_name: string;
  /** BEST_DEAL | LIGHTNING_DEAL | PRICE_DISCOUNT */
  promotion_type: string;
  report_date: string;      // YYYY-MM-DD
  redemptions: number;
  discount_amount: number;  // $ total discount given
  sales: number;            // attributed sales ($)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse a raw date string into YYYY-MM-DD.
 *  Handles: "YYYY-MM-DD", "MM/DD/YYYY", ISO strings with time component. */
function normalizeDate(raw: string): string {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [m, d, y] = s.split('/');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return s;
}

function extractJsonAmount(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === 'object' && val !== null && 'amount' in val) {
    return parseFloat(String((val as Record<string, unknown>).amount)) || 0;
  }
  return parseFloat(String(val)) || 0;
}

// ---------------------------------------------------------------------------
// createMarketingReport
// ---------------------------------------------------------------------------

/**
 * Request a GET_PROMOTION_PERFORMANCE_REPORT from SP-API.
 *
 * Uses TOP-LEVEL dataStartTime / dataEndTime (standard ARA pattern).
 * No required reportOptions — omitting promotionType returns all types
 * (BEST_DEAL, LIGHTNING_DEAL, PRICE_DISCOUNT) in one request.
 *
 * @param reportType  Must be 'GET_PROMOTION_PERFORMANCE_REPORT'
 * @param startDate   YYYY-MM-DD start of the data window
 * @param endDate     YYYY-MM-DD end of the data window
 * @returns           { reportId }
 */
export async function createMarketingReport(
  reportType: MarketingReportType,
  startDate: string,
  endDate: string
): Promise<{ reportId: string }> {
  const startIso = startDate.length === 10 ? `${startDate}T00:00:00Z` : startDate;
  const endIso   = endDate.length   === 10 ? `${endDate}T23:59:59Z`   : endDate;

  const payload: Record<string, unknown> = {
    reportType,          // 'GET_PROMOTION_PERFORMANCE_REPORT'
    reportOptions: {},   // no filter — all promotion types
    dataStartTime: startIso,
    dataEndTime:   endIso,
    marketplaceIds: ['ATVPDKIKX0DER'],
  };

  console.log(`[vendor] createMarketingReport payload: ${JSON.stringify(payload)}`);

  const data = await spApiRequest<{ reportId: string }>(
    'POST',
    '/reports/2021-06-30/reports',
    payload
  );

  if (!data.reportId) throw new Error('createMarketingReport: no reportId in response');
  return { reportId: data.reportId };
}

// ---------------------------------------------------------------------------
// parsePromotionReport
// ---------------------------------------------------------------------------

/**
 * Parse GET_PROMOTION_PERFORMANCE_REPORT output.
 *
 * Handles two formats SP-API may return:
 *
 * JSON (primary) — newline-delimited JSON or single object:
 * {
 *   "promotionPerformanceByAsin": [{
 *     "asin": "B0XXXXX",
 *     "startDate": "2024-01-01",
 *     "promotionId": "PROMO123",
 *     "promotionName": "Summer Sale",
 *     "promotionType": "BEST_DEAL",        // BEST_DEAL | LIGHTNING_DEAL | PRICE_DISCOUNT
 *     "redemptions": 42,
 *     "discountAmount":  { "amount": 84.00,  "currencyCode": "USD" },
 *     "attributedSales": { "amount": 420.00, "currencyCode": "USD" }
 *   }, ...]
 * }
 *
 * TSV (fallback) — tab-separated with a header row.
 *
 * Returns one PromotionReportRow per (asin, promotion_id, report_date).
 */
export function parsePromotionReport(raw: string): PromotionReportRow[] {
  const trimmed = raw.trim();

  // ── JSON path ──────────────────────────────────────────────────────────────
  const candidates: Record<string, unknown>[] = [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      Array.isArray(parsed) ? candidates.push(...parsed) : candidates.push(parsed as Record<string, unknown>);
    } catch { /* fall through */ }
  }

  if (candidates.length === 0) {
    for (const line of trimmed.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try { candidates.push(JSON.parse(l) as Record<string, unknown>); } catch { /* skip */ }
    }
  }

  if (candidates.length > 0) {
    const rows: PromotionReportRow[] = [];
    for (const obj of candidates) {
      const arr = obj['promotionPerformanceByAsin'] ?? obj['promotions'];
      if (!Array.isArray(arr)) continue;
      for (const r of arr as Record<string, unknown>[]) {
        const asin         = String(r.asin ?? r.ASIN ?? '').trim();
        const promotion_id = String(r.promotionId ?? r.promotion_id ?? '').trim();
        if (!asin || !promotion_id) continue;

        rows.push({
          asin,
          promotion_id,
          promotion_name: String(r.promotionName ?? r.promotion_name ?? '').trim(),
          promotion_type: String(r.promotionType ?? r.promotion_type ?? '').trim(),
          report_date:    normalizeDate(String(r.startDate ?? r.date ?? '')),
          redemptions:    parseInt(String(r.redemptions ?? 0), 10) || 0,
          discount_amount: extractJsonAmount(r.discountAmount ?? r.discount_amount),
          sales:           extractJsonAmount(r.attributedSales ?? r.sales),
        });
      }
    }
    if (rows.length > 0) {
      console.log(`[vendor] parsePromotionReport (JSON): parsed ${rows.length} rows`);
      return rows;
    }
  }

  // ── TSV fallback ──────────────────────────────────────────────────────────
  const lines = trimmed.split('\n');
  if (lines.length < 2) {
    console.warn('[vendor] parsePromotionReport: empty document');
    return [];
  }

  const headers = lines[0].split('\t').map((h) => h.trim().toLowerCase());
  const findCol = (...cs: string[]) => {
    for (const c of cs) {
      const idx = headers.findIndex((h) => h.includes(c));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const dateIdx        = findCol('date', 'start date', 'promotion start');
  const asinIdx        = findCol('asin');
  const promoIdIdx     = findCol('promotion id', 'promoid');
  const promoNameIdx   = findCol('promotion name');
  const promoTypeIdx   = findCol('promotion type');
  const redemptionsIdx = findCol('redemption');
  const discountIdx    = findCol('discount amount', 'discount');
  const salesIdx       = findCol('attributed sales', 'sales');

  if (asinIdx === -1 || promoIdIdx === -1) {
    console.warn('[vendor] parsePromotionReport (TSV): missing ASIN or Promotion ID column. headers:', headers.join(', '));
    return [];
  }

  const tsvRows: PromotionReportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const asin         = cols[asinIdx]?.trim();
    const promotion_id = cols[promoIdIdx]?.trim();
    if (!asin || !promotion_id) continue;

    const rawDate     = dateIdx !== -1 ? (cols[dateIdx]?.trim() ?? '') : '';
    const report_date = rawDate ? normalizeDate(rawDate) : '';
    if (!report_date) continue;

    tsvRows.push({
      asin,
      promotion_id,
      promotion_name:  promoNameIdx   !== -1 ? (cols[promoNameIdx]?.trim()  ?? '') : '',
      promotion_type:  promoTypeIdx   !== -1 ? (cols[promoTypeIdx]?.trim()  ?? '') : '',
      report_date,
      redemptions:     redemptionsIdx !== -1 ? parseInt(cols[redemptionsIdx]?.trim() ?? '0', 10) || 0 : 0,
      discount_amount: discountIdx    !== -1 ? (parseFloat(cols[discountIdx]?.trim().replace(/[^0-9.-]/g, '') ?? '0') || 0) : 0,
      sales:           salesIdx       !== -1 ? (parseFloat(cols[salesIdx]?.trim().replace(/[^0-9.-]/g, '')    ?? '0') || 0) : 0,
    });
  }

  console.log(`[vendor] parsePromotionReport (TSV): parsed ${tsvRows.length} rows from ${lines.length - 1} data lines`);
  return tsvRows;
}

// ---------------------------------------------------------------------------
// Convenience end-to-end helper
// ---------------------------------------------------------------------------

/**
 * Full create → poll → download → parse pipeline for
 * GET_PROMOTION_PERFORMANCE_REPORT (Vendor).
 *
 * @param startDate   YYYY-MM-DD
 * @param endDate     YYYY-MM-DD
 * @param maxAttempts Poll attempts before timeout. Default 50 (≈5 min).
 * @param intervalMs  Poll interval in ms. Default 6 000.
 */
export async function fetchAndParsePromotionReport(
  startDate: string,
  endDate: string,
  maxAttempts = 50,
  intervalMs = 6_000
): Promise<PromotionReportRow[]> {
  const { reportId } = await createMarketingReport(
    'GET_PROMOTION_PERFORMANCE_REPORT',
    startDate,
    endDate
  );
  const status = await waitForReport(reportId, maxAttempts, intervalMs);
  const raw    = await downloadReportDocument(status.reportDocumentId!);
  return parsePromotionReport(raw);
}
