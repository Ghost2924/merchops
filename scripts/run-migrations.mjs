/**
 * One-shot migration script — run this once to apply all schema changes
 * to an existing Turso database.
 *
 * Usage:
 *   node scripts/run-migrations.mjs
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

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

async function run(label, sql) {
  try {
    await db.execute(sql);
    console.log(`  ✓ ${label}`);
  } catch (err) {
    // "already exists" errors are safe to ignore
    const msg = err.message ?? '';
    if (
      msg.includes('already exists') ||
      msg.includes('duplicate column') ||
      msg.includes('UNIQUE constraint')
    ) {
      console.log(`  ~ ${label} (already exists, skipped)`);
    } else {
      console.error(`  ✗ ${label}: ${msg}`);
      throw err;
    }
  }
}

async function main() {
  console.log('Running migrations against:', TURSO_URL);

  // ── orders: add is_combo column ──────────────────────────────────────────
  await run(
    'orders table',
    `CREATE TABLE IF NOT EXISTS orders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id    TEXT    NOT NULL,
      order_date  TEXT    NOT NULL,
      sku         TEXT    NOT NULL,
      qty         INTEGER NOT NULL,
      unit_price  REAL    NOT NULL,
      total_price REAL    NOT NULL,
      is_combo    INTEGER NOT NULL DEFAULT 0
    )`
  );
  await run(
    'orders.is_combo column',
    `ALTER TABLE orders ADD COLUMN is_combo INTEGER NOT NULL DEFAULT 0`
  );
  await run('idx_orders_order_sku', `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_sku ON orders (order_id, sku)`);
  await run('idx_orders_date',      `CREATE INDEX IF NOT EXISTS idx_orders_date ON orders (order_date)`);
  await run('idx_orders_sku',       `CREATE INDEX IF NOT EXISTS idx_orders_sku ON orders (sku)`);

  // ── order_item_allocations ───────────────────────────────────────────────
  await run(
    'order_item_allocations table',
    `CREATE TABLE IF NOT EXISTS order_item_allocations (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id               TEXT    NOT NULL,
      order_date             TEXT    NOT NULL,
      physical_sku           TEXT    NOT NULL,
      qty_depleted           INTEGER NOT NULL,
      source_marketplace_sku TEXT    NOT NULL
    )`
  );
  await run('idx_alloc_date',         `CREATE INDEX IF NOT EXISTS idx_alloc_date ON order_item_allocations (order_date)`);
  await run('idx_alloc_physical_sku', `CREATE INDEX IF NOT EXISTS idx_alloc_physical_sku ON order_item_allocations (physical_sku)`);
  await run('idx_alloc_order_id',     `CREATE INDEX IF NOT EXISTS idx_alloc_order_id ON order_item_allocations (order_id)`);

  // ── marketplace_item_mappings ────────────────────────────────────────────
  await run(
    'marketplace_item_mappings table',
    `CREATE TABLE IF NOT EXISTS marketplace_item_mappings (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      marketplace_id   TEXT    NOT NULL,
      marketplace_sku  TEXT    NOT NULL,
      internal_sku     TEXT    NOT NULL,
      UNIQUE(marketplace_id, marketplace_sku)
    )`
  );
  await run('idx_mim_marketplace_sku', `CREATE INDEX IF NOT EXISTS idx_mim_marketplace_sku ON marketplace_item_mappings (marketplace_sku)`);

  // ── combo_product_recipes ────────────────────────────────────────────────
  await run(
    'combo_product_recipes table',
    `CREATE TABLE IF NOT EXISTS combo_product_recipes (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_combo_sku     TEXT    NOT NULL,
      child_inventory_sku  TEXT    NOT NULL,
      quantity_multiplier  INTEGER NOT NULL,
      UNIQUE(parent_combo_sku, child_inventory_sku)
    )`
  );
  await run('idx_cpr_parent', `CREATE INDEX IF NOT EXISTS idx_cpr_parent ON combo_product_recipes (parent_combo_sku)`);

  // ── unmapped_skus ────────────────────────────────────────────────────────
  await run(
    'unmapped_skus table',
    `CREATE TABLE IF NOT EXISTS unmapped_skus (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      marketplace_sku  TEXT    NOT NULL UNIQUE,
      first_seen       TEXT    NOT NULL,
      last_seen        TEXT    NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1
    )`
  );

  // ── inventory (ensure exists) ────────────────────────────────────────────
  await run(
    'inventory table',
    `CREATE TABLE IF NOT EXISTS inventory (
      sku           TEXT    PRIMARY KEY,
      item_title    TEXT,
      asin          TEXT,
      upc           TEXT,
      qty_on_hand   INTEGER NOT NULL DEFAULT 0,
      qty_to_ship   INTEGER NOT NULL DEFAULT 0,
      qty_available INTEGER NOT NULL DEFAULT 0,
      last_synced   TEXT    NOT NULL
    )`
  );

  // ── inventory_snapshots (ensure exists) ──────────────────────────────────
  await run(
    'inventory_snapshots table',
    `CREATE TABLE IF NOT EXISTS inventory_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sku           TEXT    NOT NULL,
      snapshot_date TEXT    NOT NULL,
      qty_available INTEGER NOT NULL DEFAULT 0
    )`
  );
  await run('idx_inv_snap_sku_date', `CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_snap_sku_date ON inventory_snapshots (sku, snapshot_date)`);
  await run('idx_inv_snap_date',     `CREATE INDEX IF NOT EXISTS idx_inv_snap_date ON inventory_snapshots (snapshot_date)`);

  console.log('\nAll migrations complete.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
