/**
 * Prints a table of all unmapped ASINs with their product title fetched
 * from Teapplix, so you can identify the correct internal_sku for each one.
 *
 * Usage:
 *   node scripts/identify-unmapped.mjs
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

function toDateStr(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(date);
}
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function main() {
  // Get all still-unmapped SKUs
  const result = await db.execute(
    `SELECT marketplace_sku, last_seen FROM unmapped_skus ORDER BY last_seen DESC`
  );
  const unmapped = result.rows.map(r => ({
    sku: r.marketplace_sku,
    last_seen: r.last_seen,
  }));

  if (unmapped.length === 0) {
    console.log('No unmapped SKUs — all clear!');
    return;
  }

  console.log(`\nFetching Teapplix product list to identify ${unmapped.length} unmapped SKUs...\n`);

  // Build ASIN → { itemName, title } from ProductQuantity
  const res = await fetch('https://api.teapplix.com/api2/ProductQuantity', {
    headers: { APIToken: TEAPPLIX_TOKEN },
  });
  if (!res.ok) throw new Error(`Teapplix API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const products = data.ProductQuantities ?? [];

  // Index by ASIN and by ItemName
  const byAsin = new Map();
  const byItemName = new Map();
  for (const p of products) {
    const asin  = (p.Asin     ?? '').trim();
    const name  = (p.ItemName ?? '').trim();
    const title = (p.ItemTitle ?? '').trim();
    if (asin) byAsin.set(asin, { itemName: name, title });
    if (name) byItemName.set(name, { asin, title });
  }

  // Also scan last 90 days of orders for ItemId matches
  console.log('Scanning last 90 days of orders for ItemId clues...');
  const unmappedSet = new Set(unmapped.map(u => u.sku));
  const orderClues = new Map(); // marketplace_sku → { itemId, title }

  let windowEnd = new Date();
  for (let week = 0; week < 13 && unmappedSet.size > 0; week++) {
    const windowStart = addDays(windowEnd, -7);
    const startStr = toDateStr(windowStart);
    const endStr   = toDateStr(windowEnd);
    process.stdout.write(`  ${startStr} → ${endStr} … `);

    const r = await fetch(
      `https://api.teapplix.com/api2/OrderNotification?PaymentDateStart=${startStr}&PaymentDateEnd=${endStr}`,
      { headers: { APIToken: TEAPPLIX_TOKEN } }
    );
    if (!r.ok) { console.log(`API error ${r.status}, skipping`); windowEnd = windowStart; continue; }
    const d = await r.json();
    const orders = d.Orders ?? [];

    let found = 0;
    for (const order of orders) {
      for (const item of order.OrderItems) {
        const name   = (item.Name   ?? '').trim();
        const itemId = (item.ItemId ?? '').trim();
        const itemTitle = (item.Title ?? item.ItemTitle ?? '').trim();
        if (unmappedSet.has(name) && itemId && !orderClues.has(name)) {
          orderClues.set(name, { itemId, title: itemTitle });
          unmappedSet.delete(name);
          found++;
        }
      }
    }
    console.log(`${orders.length} orders, ${found} new clues`);
    windowEnd = windowStart;
    await new Promise(r => setTimeout(r, 300));
  }

  // Print results
  console.log('\n' + '─'.repeat(110));
  console.log(
    'ASIN / marketplace_sku'.padEnd(40) +
    'Last Seen'.padEnd(14) +
    'Suggested internal_sku'.padEnd(24) +
    'Product Title'
  );
  console.log('─'.repeat(110));

  const seedLines = [];

  for (const { sku, last_seen } of unmapped) {
    let suggested = '';
    let title = '';

    if (byAsin.has(sku)) {
      // Found directly in product list by ASIN
      suggested = byAsin.get(sku).itemName;
      title     = byAsin.get(sku).title;
    } else if (orderClues.has(sku)) {
      // Found via order ItemId
      suggested = orderClues.get(sku).itemId;
      title     = orderClues.get(sku).title;
      // Try to enrich title from product list
      if (!title && byItemName.has(suggested)) {
        title = byItemName.get(suggested).title;
      }
    }

    const col1 = sku.length > 38 ? sku.slice(0, 35) + '...' : sku;
    console.log(
      col1.padEnd(40) +
      last_seen.padEnd(14) +
      (suggested || '???').padEnd(24) +
      (title || '(no title found)')
    );

    seedLines.push(
      suggested
        ? `  { marketplace_sku: ${JSON.stringify(sku)}, internal_sku: ${JSON.stringify(suggested)} },  // ${title || 'no title'}`
        : `  { marketplace_sku: ${JSON.stringify(sku)}, internal_sku: '' },  // UNKNOWN — last seen ${last_seen}`
    );
  }

  console.log('─'.repeat(110));

  const autoResolved = seedLines.filter(l => !l.includes("internal_sku: ''")).length;
  const stillUnknown = seedLines.filter(l =>  l.includes("internal_sku: ''")).length;

  console.log(`\n${autoResolved} can be auto-resolved, ${stillUnknown} still unknown.\n`);

  if (autoResolved > 0) {
    console.log('Copy the resolved lines below into scripts/seed-mappings.mjs and run it:\n');
    for (const line of seedLines.filter(l => !l.includes("internal_sku: ''"))) {
      console.log(line);
    }
  }

  if (stillUnknown > 0) {
    console.log('\nStill unknown (need manual lookup in Amazon Seller Central):');
    for (const line of seedLines.filter(l => l.includes("internal_sku: ''"))) {
      console.log(line);
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
