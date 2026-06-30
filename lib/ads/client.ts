/**
 * lib/ads/client.ts
 *
 * Amazon Advertising API v3 helpers.
 *
 * Covers:
 *  - LWA token refresh (shared with SP-API LWA but uses Ads-specific credentials)
 *  - Requesting a sponsored-products or sponsored-brands report
 *  - Polling until COMPLETED
 *  - Downloading + parsing the gzipped NDJSON report
 *
 * Environment variables required:
 *   AMAZON_ADS_CLIENT_ID       — LWA client id (advertising scope)
 *   AMAZON_ADS_CLIENT_SECRET   — LWA client secret
 *   AMAZON_ADS_REFRESH_TOKEN   — long-lived refresh token
 *   AMAZON_ADS_PROFILE_ID      — profile id (scope header)
 *
 * Docs: https://advertising.amazon.com/API/docs/en-us/reporting/v3/openapi
 */

import { gunzipSync } from 'zlib';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADS_API_BASE   = 'https://advertising-api.amazon.com';
const LWA_TOKEN_URL  = 'https://api.amazon.com/auth/o2/token';
const ADS_SCOPE      = 'advertising::campaign_management';

// Max poll attempts × interval before we give up (caller can resume next run)
const POLL_MAX       = 20;
const POLL_INTERVAL  = 8_000; // ms

// ---------------------------------------------------------------------------
// Token cache (in-process; refreshed when < 60s from expiry)
// ---------------------------------------------------------------------------

let _cachedToken: string | null   = null;
let _tokenExpiry: number          = 0;   // epoch ms

async function getAccessToken(): Promise<string> {
  if (_cachedToken && Date.now() < _tokenExpiry - 60_000) {
    return _cachedToken;
  }

  const clientId     = process.env.AMAZON_ADS_CLIENT_ID;
  const clientSecret = process.env.AMAZON_ADS_CLIENT_SECRET;
  const refreshToken = process.env.AMAZON_ADS_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Missing Amazon Ads credentials: AMAZON_ADS_CLIENT_ID, AMAZON_ADS_CLIENT_SECRET, AMAZON_ADS_REFRESH_TOKEN'
    );
  }

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    scope:         ADS_SCOPE,
  });

  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LWA token refresh failed ${res.status}: ${text}`);
  }

  const json = await res.json() as { access_token: string; expires_in: number };
  _cachedToken = json.access_token;
  _tokenExpiry = Date.now() + json.expires_in * 1000;
  return _cachedToken;
}

// ---------------------------------------------------------------------------
// Shared request helper — attaches auth + profile scope header
// ---------------------------------------------------------------------------

function profileId(): string {
  const id = process.env.AMAZON_ADS_PROFILE_ID;
  if (!id) throw new Error('Missing AMAZON_ADS_PROFILE_ID env var');
  return id;
}

async function adsRequest(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`${ADS_API_BASE}${path}`, {
    method,
    headers: {
      'Authorization':                `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': process.env.AMAZON_ADS_CLIENT_ID!,
      'Amazon-Advertising-API-Scope':    profileId(),
      'Content-Type':                 'application/vnd.createasyncreportrequest.v3+json',
      'Accept':                       'application/vnd.createasyncreportrequest.v3+json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CampaignType = 'SP' | 'SB' | 'SD';

export interface AdsReportRow {
  asin: string;
  reportDate: string;       // YYYY-MM-DD
  campaignType: CampaignType;
  adSpend: number;          // $ cost
  adSales: number;          // attributed sales
  impressions: number;
  clicks: number;
  acos: number | null;      // adSpend / adSales * 100, null when no sales
}

// Raw row shape from Ads API v3 report (SP advertisedProduct)
interface RawSpRow {
  advertisedAsin?:      string;
  date?:                string;
  cost?:                number | string;
  sales7d?:             number | string;
  attributedSales7d?:   number | string;
  impressions?:         number | string;
  clicks?:              number | string;
}

// Raw row shape from SB report
interface RawSbRow {
  campaignId?:          string;
  date?:                string;
  cost?:                number | string;
  attributedSales14d?:  number | string;
  impressions?:         number | string;
  clicks?:              number | string;
  // SB reports don't have per-ASIN breakdown; we attribute to a sentinel
  advertisedAsin?:      string;
}

// ---------------------------------------------------------------------------
// Report creation
// ---------------------------------------------------------------------------

interface CreateReportBody {
  name: string;
  startDate: string;     // YYYY-MM-DD
  endDate: string;       // YYYY-MM-DD
  configuration: {
    adProduct: string;
    groupBy: string[];
    columns: string[];
    reportTypeId: string;
    timeUnit: 'DAILY';
    format: 'GZIP_JSON';
  };
}

function spReportBody(startDate: string, endDate: string): CreateReportBody {
  return {
    name:      `sp-asin-${startDate}-${endDate}`,
    startDate,
    endDate,
    configuration: {
      adProduct:    'SPONSORED_PRODUCTS',
      groupBy:      ['advertiser'],
      columns:      ['date', 'advertisedAsin', 'cost', 'sales7d', 'impressions', 'clicks'],
      reportTypeId: 'spAdvertisedProduct',
      timeUnit:     'DAILY',
      format:       'GZIP_JSON',
    },
  };
}

async function createReport(body: CreateReportBody): Promise<string> {
  const res = await adsRequest('POST', '/reporting/reports', body);
  if (!res.ok) {
    const text = await res.text().catch(() => '');

    // 425 = duplicate request — Amazon returns the existing report ID in the detail string.
    // Parse it out and poll that report instead of failing.
    if (res.status === 425) {
      const match = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (match) {
        console.log(`[ads/client] duplicate report request — reusing existing reportId ${match[0]}`);
        return match[0];
      }
    }

    throw new Error(`createReport failed ${res.status}: ${text}`);
  }
  const json = await res.json() as { reportId: string };
  return json.reportId;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

interface ReportStatus {
  status:          'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  url?:            string;
  statusDetails?:  string;
}

async function getReportStatus(reportId: string): Promise<ReportStatus> {
  const res = await fetch(`${ADS_API_BASE}/reporting/reports/${reportId}`, {
    headers: {
      'Authorization':                    `Bearer ${await getAccessToken()}`,
      'Amazon-Advertising-API-ClientId':  process.env.AMAZON_ADS_CLIENT_ID!,
      'Amazon-Advertising-API-Scope':     profileId(),
      'Accept':                           'application/vnd.createasyncreportrequest.v3+json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`getReportStatus ${reportId} failed ${res.status}: ${text}`);
  }
  return res.json() as Promise<ReportStatus>;
}

async function pollUntilDone(reportId: string): Promise<string> {
  for (let attempt = 0; attempt < POLL_MAX; attempt++) {
    const status = await getReportStatus(reportId);
    if (status.status === 'COMPLETED' && status.url) return status.url;
    if (status.status === 'FAILED') {
      throw new Error(`Ads report ${reportId} FAILED: ${status.statusDetails ?? 'unknown'}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error(`Ads report ${reportId} timed out after ${POLL_MAX} attempts`);
}

// ---------------------------------------------------------------------------
// Download + parse
// ---------------------------------------------------------------------------

async function downloadAndParse(url: string): Promise<unknown[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Report download failed ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const decompressed = gunzipSync(buffer).toString('utf-8');

  const rows: unknown[] = [];
  for (const line of decompressed.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try { rows.push(JSON.parse(l)); } catch { /* skip malformed */ }
  }

  // Some reports return a JSON array instead of NDJSON
  if (rows.length === 1 && Array.isArray(rows[0])) {
    return rows[0] as unknown[];
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Parse helpers per campaign type
// ---------------------------------------------------------------------------

function parseSpRows(raw: unknown[], startDate: string, endDate: string): AdsReportRow[] {
  const results: AdsReportRow[] = [];
  for (const r of raw as RawSpRow[]) {
    const asin = r.advertisedAsin?.trim();
    if (!asin) continue;
    const date        = r.date ?? startDate;
    const adSpend     = Number(r.cost ?? 0);
    const adSales     = Number(r.sales7d ?? r.attributedSales7d ?? 0);
    const impressions = Number(r.impressions ?? 0);
    const clicks      = Number(r.clicks ?? 0);
    const acos        = adSales > 0 ? (adSpend / adSales) * 100 : null;
    results.push({ asin, reportDate: date, campaignType: 'SP', adSpend, adSales, impressions, clicks, acos });
  }
  return results;
}

function parseSbRows(raw: unknown[], startDate: string): AdsReportRow[] {
  // SB reports are campaign-level, not ASIN-level.
  // Aggregate into a single sentinel row ("__SB__") so daily_marketing_spend
  // gets the spend, but asin_ad_spend is not polluted with non-ASIN keys.
  let totalSpend = 0;
  let totalSales = 0;
  let totalImp   = 0;
  let totalClk   = 0;
  for (const r of raw as RawSbRow[]) {
    totalSpend += Number((r as RawSbRow).cost ?? 0);
    totalSales += Number((r as RawSbRow).attributedSales14d ?? 0);
    totalImp   += Number((r as RawSbRow).impressions ?? 0);
    totalClk   += Number((r as RawSbRow).clicks ?? 0);
  }
  if (totalSpend === 0) return [];
  const acos = totalSales > 0 ? (totalSpend / totalSales) * 100 : null;
  return [{
    asin:         '__SB__',
    reportDate:   startDate,
    campaignType: 'SB',
    adSpend:      totalSpend,
    adSales:      totalSales,
    impressions:  totalImp,
    clicks:       totalClk,
    acos,
  }];
}

// ---------------------------------------------------------------------------
// Sponsored Brands v2 report (SB not supported in v3 reporting API)
// ---------------------------------------------------------------------------

/**
 * SB reports are not available via the v3 /reporting/reports endpoint.
 * We use the legacy v2 API: POST /v2/hsa/campaigns/report
 * Response: { reportId: string }
 * Poll:     GET  /v2/reports/{reportId}
 * Download: gzipped JSON array
 *
 * Docs: https://advertising.amazon.com/API/docs/en-us/sponsored-brands/3-0/openapi/prod
 */

interface SbV2ReportStatus {
  status:   'IN_PROGRESS' | 'SUCCESS' | 'FAILURE';
  location?: string;
  fileSize?: number;
}

async function createSbV2Report(startDate: string, endDate: string): Promise<string> {
  const token = await getAccessToken();
  const body = {
    reportDate: startDate.replace(/-/g, ''),  // YYYYMMDD format for v2
    metrics: 'cost,attributedSales14d,impressions,clicks',
  };

  const res = await fetch(`${ADS_API_BASE}/v2/hsa/campaigns/report`, {
    method: 'POST',
    headers: {
      'Authorization':                    `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId':  process.env.AMAZON_ADS_CLIENT_ID!,
      'Amazon-Advertising-API-Scope':     profileId(),
      'Content-Type':                     'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SB v2 createReport failed ${res.status}: ${text}`);
  }
  const json = await res.json() as { reportId: string };
  return json.reportId;
}

async function pollSbV2UntilDone(reportId: string): Promise<string> {
  const token = await getAccessToken();
  for (let attempt = 0; attempt < POLL_MAX; attempt++) {
    const res = await fetch(`${ADS_API_BASE}/v2/reports/${reportId}`, {
      headers: {
        'Authorization':                    `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId':  process.env.AMAZON_ADS_CLIENT_ID!,
        'Amazon-Advertising-API-Scope':     profileId(),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SB v2 pollReport ${reportId} failed ${res.status}: ${text}`);
    }
    const status = await res.json() as SbV2ReportStatus;
    if (status.status === 'SUCCESS' && status.location) return status.location;
    if (status.status === 'FAILURE') throw new Error(`SB v2 report ${reportId} FAILED`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error(`SB v2 report ${reportId} timed out after ${POLL_MAX} attempts`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch Sponsored Products + Sponsored Brands spend for [startDate, endDate].
 *
 * Returns an array of AdsReportRow — one per ASIN per day per campaign type.
 * SP rows are ASIN-level; SB rows use sentinel "__SB__" (campaign-level only).
 *
 * Throws on hard errors (bad credentials, FAILED report).
 * Partial failures (one report type down) are caught and logged, not thrown.
 *
 * Note: SB reports use the v2 API (/v2/hsa/campaigns/report) because
 * Sponsored Brands are not supported in the v3 reporting endpoint.
 * SB v2 reports are single-date only (startDate used; endDate ignored for SB).
 */
export async function fetchAdsReport(
  startDate: string,
  endDate:   string,
): Promise<AdsReportRow[]> {
  const results: AdsReportRow[] = [];

  // ── Sponsored Products (v3) ─────────────────────────────────────────────
  try {
    console.log(`[ads/client] requesting SP report ${startDate}→${endDate}`);
    const spId  = await createReport(spReportBody(startDate, endDate));
    const spUrl = await pollUntilDone(spId);
    const spRaw = await downloadAndParse(spUrl);
    results.push(...parseSpRows(spRaw, startDate, endDate));
    console.log(`[ads/client] SP rows parsed: ${results.length}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ads/client] SP report failed:', msg);
    throw new Error(`SP report failed: ${msg}`);
  }

  // ── Sponsored Brands (v2) ───────────────────────────────────────────────
  // SB reports are daily-only in v2; request one for the startDate of the range.
  try {
    console.log(`[ads/client] requesting SB v2 report for ${startDate}`);
    const sbId  = await createSbV2Report(startDate, endDate);
    const sbUrl = await pollSbV2UntilDone(sbId);
    const sbRaw = await downloadAndParse(sbUrl);
    const sbRows = parseSbRows(sbRaw, startDate);
    results.push(...sbRows);
    console.log(`[ads/client] SB rows parsed: ${sbRows.length}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[ads/client] SB report failed (non-fatal):', msg);
  }

  return results;
}
