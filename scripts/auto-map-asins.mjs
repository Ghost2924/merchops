/**
 * Auto-maps unmapped ASINs using a two-pass strategy:
 *
 * Pass 1 — ProductQuantity ASIN lookup:
 *   Fetches all products, builds an ASIN → ItemName lookup, inserts matches.
 *
 * Pass 2 — Order ItemId fallback (90-day scan):
 *   For ASINs not found in Pass 1, scans the last 90 days of orders in
 *   weekly chunks and uses the ItemId field (which Teapplix populates with
 *   the internal warehouse SKU) as the internal_sku directly.
 *
 * Usage:
 *   node scripts/auto-map-asins.mjs
 */

import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

// Load .env.local
const envPath = new URL('../.env.local', import.meta.url).pathname;
const envLines = readFileSync(envPath, 'utf8').split('\n');
for (const line of envLines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = val;
}

const TURSO_URL      = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN    = process.env.TURSO_AUTH_TOKEN;
const TEAPPLIX_TOKEN = process.env.TEAPPLIX_API_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN || !TEAPPLIX_TOKEN) {
  console.error('Missing env vars: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, TEAPPLIX_API_TOKEN');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

async function fetchProducts() {
  const res = await fetch('https://api.teapplix.com/api2/ProductQuantity', {
    headers: { APIToken: TEAPPLIX_TOKEN },
  });
  if (!res.ok) throw new Error(`Teapplix API returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.ProductQuantities ?? [];
}

/** Format a Date as YYYY-MM-DD in LA timezone. */
function toDateStr(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(date);
}

/** Add `days` to a Date and return a new Date. */
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Scan the last `lookbackDays` days of orders in weekly chunks,
 * building a Name → ItemId map for every unmapped SKU found.
 * Weekly chunks keep each API response manageable.
 */
async function fetchOrderItemIdsForRange(unmappedSet, lookbackDays = 90) {
  const today = new Date();
  const asinToItemId = new Map();
  let remaining = new Set(unmappedSet);

  // Walk backwards in 7-day windows: [windowEnd-7 .. windowEnd]
  let windowEnd = today;
  let weekNum = 0;

  while (weekNum * 7 < lookbackDays && remaining.size > 0) {
    const windowStart = addDays(windowEnd, -7);
    const startStr = toDateStr(windowStart);
    const endStr   = toDateStr(windowEnd);

    process.stdout.write(`  Scanning ${startStr} → ${endStr} … `);

    const res = await fetch(
      `https://api.teapplix.com/api2/OrderNotification?PaymentDateStart=${startStr}&PaymentDateEnd=${endStr}`,
      { headers: { APIToken: TEAPPLIX_TOKEN } }
    );
    if (!res.ok) throw new Error(`Teapplix API returned ${res.status} for range ${startStr}→${endStr}`);
    const data = await res.json();
    const orders = data.Orders ?? [];

    let found = 0;
    for (const order of orders) {
      for (const item of order.OrderItems) {
        const name   = (item.Name   ?? '').trim();
        const itemId = (item.ItemId ?? '').trim();
        if (remaining.has(name) && itemId && !asinToItemId.has(name)) {
          asinToItemId.set(name, itemId);
          remaining.delete(name);
          found++;
        }
      }
    }

    console.log(`${orders.length} orders, ${found} new matches (${remaining.size} still needed)`);

    windowEnd = windowStart;
    weekNum++;

    // Small delay to be polite to the API
    await new Promise(r => setTimeout(r, 300));
  }

  return asinToItemId;
}

async function main() {
  // Load unmapped SKUs from DB instead of a hardcoded list
  const unmappedResult = await db.execute(
    `SELECT marketplace_sku FROM unmapped_skus ORDER BY last_seen DESC`
  );
  const UNMAPPED = unmappedResult.rows.map(r => r.marketplace_sku);

  if (UNMAPPED.length === 0) {
    console.log('No unmapped SKUs in DB — nothing to do.');
    return;
  }

  console.log(`Found ${UNMAPPED.length} unmapped SKUs in DB: ${UNMAPPED.join(', ')}\n`);

  // ── Pass 1: ProductQuantity ASIN lookup ────────────────────────────────
  console.log('Fetching Teapplix product list...');
  const products = await fetchProducts();
  console.log(`Got ${products.length} products`);

  // Build ASIN → [ItemName, ItemTitle] lookup (one ASIN can map to multiple SKUs — flag those)
  const asinMap = new Map(); // asin → { sku, title }[]
  for (const p of products) {
    const asin = (p.Asin ?? '').trim();
    const sku  = (p.ItemName ?? '').trim();
    const title = (p.ItemTitle ?? '').trim();
    if (!asin || !sku) continue;
    const list = asinMap.get(asin) ?? [];
    list.push({ sku, title });
    asinMap.set(asin, list);
  }

  console.log(`\nPass 1 — Cross-referencing ${UNMAPPED.length} unmapped SKUs against ProductQuantity...\n`);

  const toInsert = [];
  const notFound = [];
  const ambiguous = [];

  for (const marketplaceSku of UNMAPPED) {
    const matches = asinMap.get(marketplaceSku);

    if (!matches || matches.length === 0) {
      notFound.push(marketplaceSku);
      console.log(`  ✗ ${marketplaceSku}  — not found in Teapplix product list`);
    } else if (matches.length > 1) {
      ambiguous.push({ marketplaceSku, matches });
      console.log(`  ⚠ ${marketplaceSku}  — ${matches.length} matches (ambiguous):`);
      for (const m of matches) {
        console.log(`      ${m.sku}  "${m.title}"`);
      }
    } else {
      const { sku, title } = matches[0];
      toInsert.push({ marketplace_sku: marketplaceSku, internal_sku: sku });
      console.log(`  ✓ ${marketplaceSku}  →  ${sku}  "${title}"`);
    }
  }

  console.log(`\n--- Pass 1 Summary ---`);
  console.log(`  Matched:   ${toInsert.length}`);
  console.log(`  Ambiguous: ${ambiguous.length}`);
  console.log(`  Not found: ${notFound.length}`);

  // ── Pass 2: Order ItemId fallback (90-day scan) ───────────────────────
  // For ASINs not found in ProductQuantity, scan the last 90 days of orders
  // in weekly chunks and use the ItemId field as the internal warehouse SKU.
  if (notFound.length > 0) {
    console.log(`\nPass 2 — Scanning last 90 days of orders to resolve ${notFound.length} remaining SKUs...`);
    const unmappedSet = new Set(notFound);
    const asinToItemId = await fetchOrderItemIdsForRange(unmappedSet, 90);

    const stillNotFound = [];
    for (const marketplaceSku of notFound) {
      const itemId = asinToItemId.get(marketplaceSku);
      if (itemId) {
        toInsert.push({ marketplace_sku: marketplaceSku, internal_sku: itemId });
        console.log(`  ✓ ${marketplaceSku}  →  ${itemId}  (via order ItemId)`);
      } else {
        stillNotFound.push(marketplaceSku);
        console.log(`  ✗ ${marketplaceSku}  — not found in last 90 days of orders`);
      }
    }
    notFound.length = 0;
    notFound.push(...stillNotFound);
  }

  console.log(`\n--- Final Summary ---`);
  console.log(`  Resolved:  ${toInsert.length}`);
  console.log(`  Ambiguous: ${ambiguous.length}`);
  console.log(`  Not found: ${notFound.length}`);

  if (toInsert.length === 0) {
    console.log('\nNothing to insert.');
    if (notFound.length > 0) {
      console.log('\nThese SKUs need manual mapping in scripts/seed-mappings.mjs:');
      for (const s of notFound) console.log(`  { marketplace_sku: '${s}', internal_sku: '' },`);
    }
    return;
  }

  console.log(`\nInserting ${toInsert.length} mappings...`);
  const BATCH = 100;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const chunk = toInsert.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT OR REPLACE INTO marketplace_item_mappings
                (marketplace_id, marketplace_sku, internal_sku)
              VALUES (?, ?, ?)`,
        args: ['AMAZON_US', r.marketplace_sku, r.internal_sku],
      }))
    );
  }

  // Clear resolved SKUs from unmapped_skus log
  const resolvedSkus = toInsert.map((r) => r.marketplace_sku);
  const placeholders = resolvedSkus.map(() => '?').join(',');
  const del = await db.execute({
    sql: `DELETE FROM unmapped_skus WHERE marketplace_sku IN (${placeholders})`,
    args: resolvedSkus,
  });
  console.log(`  ${del.rowsAffected} entries cleared from unmapped_skus log`);

  // Handle ambiguous — print manual instructions
  if (ambiguous.length > 0) {
    console.log('\n⚠ Ambiguous ASINs need manual resolution.');
    console.log('Add them to scripts/seed-mappings.mjs with the correct internal_sku:');
    for (const { marketplaceSku, matches } of ambiguous) {
      console.log(`\n  { marketplace_sku: '${marketplaceSku}', internal_sku: '' },`);
      console.log(`  // Options:`);
      for (const m of matches) {
        console.log(`  //   '${m.sku}'  "${m.title}"`);
      }
    }
  }

  if (notFound.length > 0) {
    console.log('\n✗ Still unresolved — add manually to scripts/seed-mappings.mjs:');
    for (const s of notFound) console.log(`  { marketplace_sku: '${s}', internal_sku: '' },`);
  }

  console.log('\nDone. Run a manual sync to re-process today\'s orders:');
  console.log('  POST /api/manual-sync');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
