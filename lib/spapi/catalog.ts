/**
 * SP-API Catalog Items client — title lookup only.
 *
 * Used by /api/vendor-central to fill in titles for ASINs that have no entry
 * in inventory_products or combo_products.
 *
 * Auth: reuses getAmazonAccessToken() from lib/amazonVendor.ts (same LWA flow).
 *
 * Rate limit: Catalog Items 2022-04-01 allows 2 req/s burst with a quota of 40.
 * We batch-chunk calls and add a small delay between chunks.
 */

import { getAmazonAccessToken } from '../amazonVendor';

const SP_API_BASE = 'https://sellingpartnerapi-na.amazon.com';
const US_MARKETPLACE = 'ATVPDKIKX0DER';

/**
 * Fetch titles for a list of ASINs from the SP-API Catalog Items API.
 *
 * Returns a Map<asin, title>. ASINs not found or errored are omitted.
 * Requests are made one at a time to stay within rate limits (2 req/s).
 *
 * @param asins  List of ASINs to look up.
 * @param delayMs  Delay between individual requests (ms). Default 550 ms → ~1.8 req/s.
 */
export async function fetchAsinTitles(
  asins: string[],
  delayMs = 550
): Promise<Map<string, string>> {
  const titleMap = new Map<string, string>();
  if (asins.length === 0) return titleMap;

  let accessToken: string;
  try {
    accessToken = await getAmazonAccessToken();
  } catch (err) {
    console.warn('[catalog-api] could not get access token, skipping title fetch:', err);
    return titleMap;
  }

  for (const asin of asins) {
    try {
      const url =
        `${SP_API_BASE}/catalog/2022-04-01/items/${encodeURIComponent(asin)}` +
        `?marketplaceIds=${US_MARKETPLACE}&includedData=summaries`;

      const res = await fetch(url, {
        headers: {
          'x-amz-access-token': accessToken,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        if (res.status !== 404) {
          console.warn(`[catalog-api] GET ${asin} → ${res.status}`);
        }
        // 404 = ASIN not found in this marketplace; skip silently
        continue;
      }

      // Response shape (abbreviated):
      // { asin, summaries: [{ marketplaceId, itemName, ... }] }
      const data = await res.json() as {
        asin?: string;
        summaries?: Array<{ marketplaceId?: string; itemName?: string }>;
      };

      const summary = data.summaries?.find(
        (s) => s.marketplaceId === US_MARKETPLACE
      ) ?? data.summaries?.[0];

      const title = summary?.itemName?.trim();
      if (title) titleMap.set(asin, title);
    } catch (err) {
      console.warn(`[catalog-api] error fetching ASIN ${asin}:`, err);
    }

    // Rate-limit guard
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return titleMap;
}
