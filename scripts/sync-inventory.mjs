/**
 * One-shot inventory sync: fetches ProductQuantity from Teapplix and
 * upserts into the inventory table + writes a daily snapshot.
 *
 * Usage:
 *   node scripts/sync-inventory.mjs
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

const TURSO_URL    = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN  = process.env.TURSO_AUTH_TOKEN;
const TEAPPLIX_TOKEN = process.env.TEAPPLIX_API_TOKEN;
const TZ = process.env.BUSINESS_TIMEZONE ?? 'America/Los_Angeles';

if (!TURSO_URL || !TURSO_TOKEN || !TEAPPLIX_TOKEN) {
  console.error('Missing env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, TEAPPLIX_API_TOKEN');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

function getTodayInTz() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

/** Mirrors canonicalizeSku from lib/db/queries.ts */
function canonicalizeSku(raw) {
  let s = (raw ?? '').trim();
  const numMatch = s.match(/^(.+)-(\d+)$/);
  if (numMatch) s = numMatch[1];

  if (s.startsWith('AM-')) {
    // already canonical
  } else if (/^AM\d/i.test(s)) {
    s = 'AM-' + s.slice(2);
  } else if (!s.toUpperCase().startsWith('AM')) {
    s = 'AM-' + s;
  }
  s = s.replace(/^AM-AM-/i, 'AM-');
  return s;
}

async function fetchInventory() {
  const res = await fetch('https://api.teapplix.com/api2/ProductQuantity', {
    headers: { APIToken: TEAPPLIX_TOKEN },
  });
  if (!res.ok) throw new Error(`Teapplix API returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.ProductQuantities ?? [];
}

async function main() {
  console.log('Fetching inventory from Teapplix...');
  const products = await fetchInventory();
  console.log(`Fetched ${products.length} products`);

  // Exclude combo items — qty derived from components
  const items = products.filter(
    (p) => (p.ItemType ?? '').toLowerCase() !== 'combo item'
  );
  console.log(`${products.length - items.length} combo items excluded, ${items.length} inventory items kept`);

  // Aggregate pack variants into one canonical row per SKU.
  // e.g. AM5233-1 (696) + AM5233-2 (348) + AM5233-5 (139) + AM5233-10 (69)
  // all canonicalize to AM-5233 → sum qty fields.
  const aggregated = new Map(); // canonical_sku → aggregated row
  for (const p of items) {
    const sku = canonicalizeSku(p.ItemName ?? '');
    if (!aggregated.has(sku)) {
      aggregated.set(sku, {
        sku,
        item_title: p.ItemTitle ?? '',
        asin: p.Asin ?? '',
        upc: p.Upc ?? '',
        qty_on_hand: 0,
        qty_to_ship: 0,
        qty_available: 0,
      });
    }
    const row = aggregated.get(sku);
    row.qty_on_hand   += Number(p.QtyOnHand)   || 0;
    row.qty_to_ship   += Number(p.QtyToShip)   || 0;
    row.qty_available += Number(p.QtyAvailable) || 0;
    // Keep first non-empty title/asin/upc
    if (!row.item_title && p.ItemTitle) row.item_title = p.ItemTitle;
    if (!row.asin && p.Asin) row.asin = p.Asin;
    if (!row.upc && p.Upc) row.upc = p.Upc;
  }

  const rows = [...aggregated.values()];
  console.log(`Aggregated ${items.length} variants → ${rows.length} canonical SKUs`);

  const today = getTodayInTz();
  const now = new Date().toISOString();
  const BATCH = 100;

  // Upsert inventory
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT OR REPLACE INTO inventory
                (sku, item_title, asin, upc, qty_on_hand, qty_to_ship, qty_available, last_synced)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [r.sku, r.item_title, r.asin, r.upc, r.qty_on_hand, r.qty_to_ship, r.qty_available, now],
      }))
    );
    upserted += chunk.length;
    process.stdout.write(`\r  Upserted ${upserted}/${rows.length}...`);
  }
  console.log(`\r  Upserted ${upserted} canonical inventory rows.`);

  // Write daily snapshots
  let snapped = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT OR REPLACE INTO inventory_snapshots (sku, snapshot_date, qty_available)
              VALUES (?, ?, ?)`,
        args: [r.sku, today, r.qty_available],
      }))
    );
    snapped += chunk.length;
  }
  console.log(`  Wrote ${snapped} snapshot rows for ${today}.`);

  // Summary: show top 20 by qty_available
  const top = await db.execute(
    `SELECT sku, qty_available FROM inventory ORDER BY qty_available DESC LIMIT 20`
  );
  console.log('\nTop 20 by available stock:');
  for (const r of top.rows) {
    console.log(`  ${String(r.sku).padEnd(20)} ${r.qty_available}`);
  }

  const total = await db.execute('SELECT COUNT(*) as cnt FROM inventory');
  console.log(`\nTotal inventory rows in DB: ${total.rows[0].cnt}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
