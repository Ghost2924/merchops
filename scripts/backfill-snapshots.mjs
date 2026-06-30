#!/usr/bin/env node
/**
 * Backfill inventory_snapshots for the last 90 days.
 *
 * For each active SKU in inventory_products with current_qty > 0,
 * inserts one row per day (today-1 back to today-90) using current_qty
 * as the qty_available proxy.
 *
 * Uses INSERT OR IGNORE so existing rows are never overwritten.
 *
 * Run: node scripts/backfill-snapshots.mjs
 */

import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse .env.local manually (no dotenv dependency needed)
const envPath = resolve(__dirname, '../.env.local');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = val;
}

const TURSO_URL       = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH      = process.env.TURSO_AUTH_TOKEN;
const BACKFILL_DAYS   = 90;
const BATCH_SIZE      = 200; // rows per batch

if (!TURSO_URL) { console.error('Missing TURSO_DATABASE_URL'); process.exit(1); }

const db = createClient({ url: TURSO_URL, authToken: TURSO_AUTH });

// ── helpers ──────────────────────────────────────────────────────────────────

/** YYYY-MM-DD for today-N in America/Los_Angeles */
function dateNDaysAgo(n) {
  const d = new Date();
  d.setTime(d.getTime() - n * 86_400_000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); // en-CA = YYYY-MM-DD
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────

console.log('Fetching active inventory SKUs...');
const invResult = await db.execute(
  `SELECT sku, current_qty FROM inventory_products WHERE active = 1 AND current_qty > 0`
);

const skus = invResult.rows.map(r => ({ sku: String(r.sku), qty: Number(r.current_qty) }));
console.log(`Found ${skus.length} active SKUs with stock > 0`);

// Build date list: today-1 … today-90 (skip today — nightly sync writes today)
const dates = [];
for (let n = 1; n <= BACKFILL_DAYS; n++) dates.push(dateNDaysAgo(n));

// Flatten into (sku, date, qty) triples
const allRows = [];
for (const { sku, qty } of skus) {
  for (const date of dates) {
    allRows.push({ sku, date, qty });
  }
}

console.log(`Total rows to insert (INSERT OR IGNORE): ${allRows.length}`);

// Check existing count first
const existingResult = await db.execute(
  `SELECT COUNT(*) AS cnt FROM inventory_snapshots WHERE snapshot_date >= ?`,
  [dateNDaysAgo(BACKFILL_DAYS)]
);
const existingCount = Number(existingResult.rows[0].cnt);
console.log(`Existing snapshot rows in window: ${existingCount}`);

// Insert in batches
const batches = chunkArray(allRows, BATCH_SIZE);
let inserted = 0;
let batchNum = 0;

for (const batch of batches) {
  batchNum++;
  await db.batch(
    batch.map(({ sku, date, qty }) => ({
      sql: `INSERT OR IGNORE INTO inventory_snapshots (sku, snapshot_date, qty_available) VALUES (?, ?, ?)`,
      args: [sku, date, qty],
    }))
  );
  inserted += batch.length;
  process.stdout.write(`\r  Batches: ${batchNum}/${batches.length}  (${inserted}/${allRows.length} rows)`);
}

console.log('\nDone.');

// Verify
const afterResult = await db.execute(
  `SELECT COUNT(*) AS cnt FROM inventory_snapshots WHERE snapshot_date >= ?`,
  [dateNDaysAgo(BACKFILL_DAYS)]
);
const afterCount = Number(afterResult.rows[0].cnt);
console.log(`Snapshot rows in window after backfill: ${afterCount} (added ~${afterCount - existingCount})`);

// Spot-check 5303-1
const checkResult = await db.execute(
  `SELECT COUNT(*) AS snap_days, MIN(snapshot_date) AS earliest, MAX(snapshot_date) AS latest
   FROM inventory_snapshots
   WHERE sku = 'AM5303-1' AND snapshot_date >= ?`,
  [dateNDaysAgo(90)]
);
const row = checkResult.rows[0];
console.log(`\nAM5303-1 spot check: ${row.snap_days} snap days  (${row.earliest} → ${row.latest})`);

process.exit(0);
