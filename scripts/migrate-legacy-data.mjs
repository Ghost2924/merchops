/**
 * migrate-legacy-data.mjs
 *
 * Migrates historical data from legacy tables into the new schema:
 *   orders              → order_lines
 *   order_item_allocations → inventory_allocations
 *
 * Safe to run multiple times (INSERT OR IGNORE).
 *
 * Usage:
 *   node scripts/migrate-legacy-data.mjs
 */

import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse .env.local manually (no dotenv dependency needed)
function loadEnv(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (_) {}
}
loadEnv(resolve(__dirname, '../.env.local'));

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const BATCH = 500;

async function migrateOrderLines() {
  console.log('\n── Migrating orders → order_lines ──');

  const countResult = await db.execute('SELECT COUNT(*) as cnt, MAX(id) as maxId FROM orders');
  const total = Number(countResult.rows[0].cnt);
  const maxId = Number(countResult.rows[0].maxId);
  console.log(`  ${total} total rows in orders (max id: ${maxId})`);

  let lastId = 0;
  let migrated = 0;

  while (lastId <= maxId) {
    const rows = await db.execute({
      sql: `SELECT id, order_id, order_date, sku, resolved_sku, qty, total_price, is_combo
            FROM orders
            WHERE id > ? AND id <= ?
            ORDER BY id ASC`,
      args: [lastId, lastId + BATCH],
    });

    if (rows.rows.length === 0) {
      lastId += BATCH;
      continue;
    }

    const statements = rows.rows.map((r) => {
      const rawSku = String(r.sku ?? '');
      const resolvedSku = r.resolved_sku ? String(r.resolved_sku) : null;
      const effectiveResolved = resolvedSku ?? rawSku;
      const productType = Number(r.is_combo) === 1 ? 'combo' : 'inventory';

      return {
        sql: `INSERT OR IGNORE INTO order_lines
                (order_line_id, customer_order_id, order_date, marketplace,
                 raw_storefront_sku, resolved_teapplix_sku, resolved_product_type,
                 qty_sold, revenue, mapping_status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'mapped', datetime('now'))`,
        args: [
          String(r.order_id),
          String(r.order_id).split('|')[0],
          String(r.order_date),
          'UNKNOWN',
          rawSku,
          effectiveResolved,
          productType,
          Number(r.qty),
          Number(r.total_price),
        ],
      };
    });

    await db.batch(statements);
    migrated += rows.rows.length;
    lastId += BATCH;
    process.stdout.write(`\r  Migrated ~${migrated} rows (id cursor: ${lastId})...`);
  }

  console.log(`\n  ✓ Done. ~${migrated} rows processed`);
}

async function migrateAllocations() {
  console.log('\n── Migrating order_item_allocations → inventory_allocations ──');

  const countResult = await db.execute('SELECT COUNT(*) as cnt, MAX(id) as maxId FROM order_item_allocations');
  const total = Number(countResult.rows[0].cnt);
  const maxId = Number(countResult.rows[0].maxId);
  console.log(`  ${total} total rows (max id: ${maxId})`);

  let lastId = 0;
  let migrated = 0;

  while (lastId <= maxId) {
    const rows = await db.execute({
      sql: `SELECT id, order_id, order_date, physical_sku, qty_depleted, source_marketplace_sku
            FROM order_item_allocations
            WHERE id > ? AND id <= ?
            ORDER BY id ASC`,
      args: [lastId, lastId + BATCH],
    });

    if (rows.rows.length === 0) {
      lastId += BATCH;
      continue;
    }

    const statements = rows.rows.map((r) => ({
      sql: `INSERT OR IGNORE INTO inventory_allocations
              (allocation_id, order_line_id, inventory_sku, qty_depleted,
               source_teapplix_sku, source_storefront_sku, allocation_type, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'direct', ?)`,
      args: [
        `legacy|${r.id}`,
        String(r.order_id),
        String(r.physical_sku),
        Number(r.qty_depleted),
        String(r.physical_sku),
        String(r.source_marketplace_sku),
        `${String(r.order_date)}T00:00:00`,
      ],
    }));

    await db.batch(statements);
    migrated += rows.rows.length;
    lastId += BATCH;
    process.stdout.write(`\r  Migrated ~${migrated} rows (id cursor: ${lastId})...`);
  }

  console.log(`\n  ✓ Done. ~${migrated} rows processed`);
}

async function verify() {
  console.log('\n── Verification ──');
  const r1 = await db.execute(`SELECT strftime('%Y', order_date) as yr, COUNT(*) as cnt FROM order_lines GROUP BY yr ORDER BY yr`);
  console.log('  order_lines by year:', r1.rows.map(r => `${r.yr}: ${r.cnt}`).join(', '));
  const r2 = await db.execute(`SELECT strftime('%Y', DATE(created_at)) as yr, COUNT(*) as cnt FROM inventory_allocations GROUP BY yr ORDER BY yr`);
  console.log('  inventory_allocations by year:', r2.rows.map(r => `${r.yr}: ${r.cnt}`).join(', '));
  const r3 = await db.execute(`SELECT strftime('%Y-%m', created_at) as mo, SUM(qty_depleted) as qty FROM inventory_allocations WHERE strftime('%Y', DATE(created_at)) = '2025' AND strftime('%m', DATE(created_at)) IN ('06','07','08') GROUP BY mo ORDER BY mo`);
  console.log('  Summer 2025 allocations:', r3.rows.map(r => `${r.mo}: ${r.qty}`).join(', ') || 'none');
}

async function main() {
  console.log('Starting legacy data migration...');
  console.log(`DB: ${process.env.TURSO_DATABASE_URL}`);
  await migrateOrderLines();
  await migrateAllocations();
  await verify();
  console.log('\nDone.');
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
