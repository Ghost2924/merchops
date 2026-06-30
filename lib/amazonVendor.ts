/**
 * Amazon Vendor SP-API + Ads API utility
 *
 * Auth flow: read refresh token from env → exchange for short-lived LWA access
 * token → use for SP-API / Ads API calls. Token cached in memory for 55 min
 * (LWA tokens expire at 60 min). No DB lookup.
 *
 * Env vars required:
 *   AMAZON_VENDOR_CLIENT_ID        – LWA client ID
 *   AMAZON_VENDOR_CLIENT_SECRET    – LWA client secret
 *   AMAZON_VENDOR_REFRESH_TOKEN    – long-lived refresh token (SP-API)
 *   AMAZON_ADS_REFRESH_TOKEN       – long-lived refresh token for Ads API
 *                                    (must have advertising::campaign_management scope)
 *                                    Obtain via LwA OAuth:
 *                                    https://www.amazon.com/ap/oa?client_id=<CLIENT_ID>
 *                                      &scope=advertising::campaign_management
 *                                      &response_type=code&redirect_uri=<REDIRECT_URI>
 *   AMAZON_ADS_PROFILE_ID          – Ads API profile ID (Ads calls only)
 */

import { getOrgContext } from './db/context';
import { getOrganizationCredentials } from './db/queries';

const TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const SP_API_BASE = 'https://sellingpartnerapi-na.amazon.com';
const ADS_API_BASE = 'https://advertising-api.amazon.com';

// ---------------------------------------------------------------------------
// In-memory token cache (server process lifetime)
// ---------------------------------------------------------------------------

interface TokenCache {
  accessToken: string;
  expiresAt: number; // ms epoch
}

const _tokenCaches = new Map<string, TokenCache>();
const _adsTokenCaches = new Map<string, TokenCache>();
// Refresh 5 min before true expiry (LWA tokens live 3600 s)
const TOKEN_TTL_MS = 55 * 60 * 1000;

// ---------------------------------------------------------------------------
// Token exchange (internal helper)
// ---------------------------------------------------------------------------

async function exchangeRefreshToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  label: string
): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Amazon token exchange failed [${label}] (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error(`Amazon token response missing access_token [${label}]`);
  }
  return data.access_token;
}

// ---------------------------------------------------------------------------
// SP-API token (uses AMAZON_VENDOR_REFRESH_TOKEN)
// ---------------------------------------------------------------------------

export async function getAmazonAccessToken(): Promise<string> {
  const now = Date.now();
  const { orgId } = getOrgContext();
  const cacheKey = orgId ?? 'system';

  const cached = _tokenCaches.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    return cached.accessToken;
  }

  let refreshToken: string | undefined;
  let clientId: string | undefined;
  let clientSecret: string | undefined;

  if (orgId) {
    const creds = await getOrganizationCredentials(orgId);
    refreshToken = creds?.amazon_refresh_token;
    clientId = creds?.amazon_client_id;
    clientSecret = creds?.amazon_client_secret;
  }

  // Fallback to environment variables
  refreshToken = refreshToken || process.env.AMAZON_VENDOR_REFRESH_TOKEN;
  clientId = clientId || process.env.AMAZON_VENDOR_CLIENT_ID;
  clientSecret = clientSecret || process.env.AMAZON_VENDOR_CLIENT_SECRET;

  if (!refreshToken) throw new Error(`Missing AMAZON_VENDOR_REFRESH_TOKEN for org ${cacheKey}`);
  if (!clientId) throw new Error(`Missing AMAZON_VENDOR_CLIENT_ID for org ${cacheKey}`);
  if (!clientSecret) throw new Error(`Missing AMAZON_VENDOR_CLIENT_SECRET for org ${cacheKey}`);

  const accessToken = await exchangeRefreshToken(refreshToken, clientId, clientSecret, 'SP-API');
  _tokenCaches.set(cacheKey, { accessToken, expiresAt: now + TOKEN_TTL_MS });
  return accessToken;
}

// ---------------------------------------------------------------------------
// Ads API token (uses AMAZON_ADS_REFRESH_TOKEN — advertising scope)
//
// To obtain AMAZON_ADS_REFRESH_TOKEN, authorize via LwA with scope
// "advertising::campaign_management":
//   https://www.amazon.com/ap/oa?client_id=<CLIENT_ID>
//     &scope=advertising::campaign_management
//     &response_type=code&redirect_uri=<REDIRECT_URI>
// Exchange the returned code for a refresh token via POST to TOKEN_URL.
// ---------------------------------------------------------------------------

export async function getAdsAccessToken(): Promise<string> {
  const now = Date.now();
  const { orgId } = getOrgContext();
  const cacheKey = orgId ?? 'system';

  const cached = _adsTokenCaches.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    return cached.accessToken;
  }

  let refreshToken: string | undefined;
  let clientId: string | undefined;
  let clientSecret: string | undefined;

  if (orgId) {
    const creds = await getOrganizationCredentials(orgId);
    refreshToken = creds?.amazon_refresh_token;
    clientId = creds?.amazon_client_id;
    clientSecret = creds?.amazon_client_secret;
  }

  // Fallback to environment variables
  refreshToken = refreshToken || process.env.AMAZON_ADS_REFRESH_TOKEN || process.env.AMAZON_VENDOR_REFRESH_TOKEN;
  clientId = clientId || process.env.AMAZON_ADS_CLIENT_ID || process.env.AMAZON_VENDOR_CLIENT_ID;
  clientSecret = clientSecret || process.env.AMAZON_ADS_CLIENT_SECRET || process.env.AMAZON_VENDOR_CLIENT_SECRET;

  if (!refreshToken) throw new Error(`Missing AMAZON_ADS_REFRESH_TOKEN for org ${cacheKey}`);
  if (!clientId) throw new Error(`Missing AMAZON_VENDOR_CLIENT_ID for org ${cacheKey}`);
  if (!clientSecret) throw new Error(`Missing AMAZON_VENDOR_CLIENT_SECRET for org ${cacheKey}`);

  const accessToken = await exchangeRefreshToken(refreshToken, clientId, clientSecret, 'Ads API');
  _adsTokenCaches.set(cacheKey, { accessToken, expiresAt: now + TOKEN_TTL_MS });
  return accessToken;
}

// ---------------------------------------------------------------------------
// Vendor Orders
// ---------------------------------------------------------------------------

export interface VendorOrder {
  purchaseOrderNumber: string;
  purchaseOrderState: string;
  orderDetails?: Record<string, unknown>;
}

interface VendorOrdersResponse {
  payload?: {
    orders?: VendorOrder[];
    nextToken?: string;
  };
}

/**
 * Fetch vendor orders from SP-API for a given date window.
 * @param createdAfter  ISO-8601 string, e.g. "2024-01-01T00:00:00Z"
 * @param createdBefore ISO-8601 string (optional)
 */
export async function fetchVendorOrders(
  createdAfter: string,
  createdBefore?: string
): Promise<VendorOrder[]> {
  const accessToken = await getAmazonAccessToken();

  const params = new URLSearchParams({ createdAfter });
  if (createdBefore) params.set('createdBefore', createdBefore);

  const url = `${SP_API_BASE}/vendor/orders/v1/purchaseOrders?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SP-API vendor orders failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as VendorOrdersResponse;
  return data.payload?.orders ?? [];
}

// ---------------------------------------------------------------------------
// Ads API
// ---------------------------------------------------------------------------

/**
 * Generic authenticated GET for Amazon Ads API.
 * Requires AMAZON_ADS_PROFILE_ID env var.
 *
 * @param path  e.g. "/v2/campaigns"
 * @param params  query string params
 */
export async function fetchAdsApi<T = unknown>(
  path: string,
  params?: Record<string, string>
): Promise<T> {
  const profileId = process.env.AMAZON_ADS_PROFILE_ID;
  if (!profileId) throw new Error('Missing AMAZON_ADS_PROFILE_ID env var');

  const accessToken = await getAdsAccessToken();

  const url = new URL(`${ADS_API_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const { orgId } = getOrgContext();
  let dbClientId: string | undefined;
  if (orgId) {
    const creds = await getOrganizationCredentials(orgId);
    dbClientId = creds?.amazon_client_id;
  }
  const resolvedClientId = dbClientId || process.env.AMAZON_ADS_CLIENT_ID || process.env.AMAZON_VENDOR_CLIENT_ID || '';

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Amazon-Advertising-API-ClientId': resolvedClientId,
      'Amazon-Advertising-API-Scope': profileId,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ads API ${path} failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<T>;
}
