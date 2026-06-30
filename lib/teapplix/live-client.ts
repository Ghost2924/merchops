// Direct Teapplix REST API v2 client
// Auth: APIToken header (no account name needed)
// Base: https://api.teapplix.com/api2

import { getOrgContext } from '@/lib/db/context';
import { getOrganizationCredentials } from '@/lib/db/queries';

const BASE = 'https://api.teapplix.com/api2';

export interface TeapplixOrderItem {
  Name: string;        // SKU / ASIN
  ItemId: string;      // Internal item ID
  Description: string;
  Quantity: number;
  Amount: number;      // Line total USD
  LineNumber: number;
}

export interface TeapplixOrder {
  TxnId: string;
  StoreType: string;
  StoreKey: string;
  PaymentStatus: string;
  LastUpdateDate: string;
  OrderTotals: {
    Shipping: number;
    Tax: number;
    Fee: number;
    Total: number;
    Currency: string;
  };
  OrderDetails: {
    Invoice: string;
    PaymentDate: string;
    QueueId: number;
    ShipClass: string;
  };
  OrderItems: TeapplixOrderItem[];
  SeqNumber: string;
}

async function getToken(): Promise<string> {
  const { orgId } = getOrgContext();
  if (orgId) {
    const creds = await getOrganizationCredentials(orgId);
    if (creds?.teapplix_api_key) {
      return creds.teapplix_api_key;
    }
  }
  // Support both TEAPPLIX_API_TOKEN (preferred) and legacy TEAPPLIX_USER/TEAPPLIX_PASSWORD
  const token = process.env.TEAPPLIX_API_TOKEN;
  if (token) return token;
  throw new Error('Missing TEAPPLIX_API_TOKEN env var — set it in .env.local');
}

/** Fetch with automatic retry on 503/429 (up to 3 attempts, exponential backoff). */
async function fetchWithRetry(url: string, token: string, attempt = 1): Promise<Response> {
  const res = await fetch(url, {
    headers: { APIToken: token },
    cache: 'no-store',
  });

  if ((res.status === 503 || res.status === 429) && attempt < 3) {
    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000); // 1s, 2s
    console.warn(`[TeapplixClient] ${res.status} on attempt ${attempt}, retrying in ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
    return fetchWithRetry(url, token, attempt + 1);
  }

  return res;
}

/**
 * Fetch all orders for a given date range (paginates automatically).
 * Uses PaymentDate range.
 */
export async function fetchOrdersByDate(
  startDate: string, // YYYY-MM-DD
  endDate: string,    // YYYY-MM-DD
  notShipped?: boolean
): Promise<TeapplixOrder[]> {
  const token = await getToken();
  const allOrders: TeapplixOrder[] = [];
  let seqStart: number | null = null;

  while (true) {
    const url = new URL(`${BASE}/OrderNotification`);
    url.searchParams.set('PaymentDateStart', startDate);
    url.searchParams.set('PaymentDateEnd', endDate);
    if (notShipped) {
      url.searchParams.set('NotShipped', '1');
    }
    if (seqStart !== null) {
      url.searchParams.set('SeqStart', String(seqStart));
    }

    const res = await fetchWithRetry(url.toString(), token);

    if (!res.ok) {
      const body = await res.text();
      console.error(`[TeapplixClient] HTTP ${res.status}: ${body}`);
      if (res.status === 503) throw new Error('Teapplix API unavailable (503) — try again in a few minutes');
      if (res.status === 429) throw new Error('Teapplix API rate limited (429) — try again shortly');
      throw new Error(`Teapplix API returned ${res.status}`);
    }

    const data = await res.json();
    const orders: TeapplixOrder[] = data.Orders ?? [];
    allOrders.push(...orders);

    // Paginate: if we got a full page, continue from next seq
    const pagination = data.Pagination;
    if (pagination && pagination.PageNumber < pagination.TotalPages) {
      const lastSeq = parseInt(orders[orders.length - 1].SeqNumber, 10);
      seqStart = lastSeq + 1;
    } else {
      break;
    }
  }

  return allOrders;
}

/**
 * Fetch current inventory quantities for all products.
 */
export async function fetchInventory() {
  const token = await getToken();
  const res = await fetchWithRetry(`${BASE}/ProductQuantity`, token);
  if (!res.ok) throw new Error(`Teapplix API returned ${res.status}`);
  const data = await res.json();
  return data.ProductQuantities ?? [];
}
