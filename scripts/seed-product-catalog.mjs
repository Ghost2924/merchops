/**
 * seed-product-catalog.mjs
 *
 * Imports products.csv and comboproducts.csv into the database.
 * This is the source of truth for all SKU type classification.
 *
 * Usage:
 *   node scripts/seed-product-catalog.mjs
 *
 * What it does:
 *   1. Reads products.csv → splits into inventory_products (type 0),
 *      combo_products (type 1), needs_review_products (type 2 or invalid)
 *   2. Reads comboproducts.csv → inserts combo_components (recipe table)
 *   3. Validates: every combo parent must exist in combo_products,
 *      every combo child must exist in inventory_products
 *   4. Logs all validation errors to mapping_errors table
 */

import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Papa from 'papaparse';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load env
const envPath = join(ROOT, '.env.local');
let TURSO_DATABASE_URL, TURSO_AUTH_TOKEN;
try {
  const env = readFileSync(envPath, 'utf8');
  for (const line of env.split('\n')) {
    const [k, ...v] = line.split('=');
    if (k?.trim() === 'TURSO_DATABASE_URL') TURSO_DATABASE_URL = v.join('=').trim();
    if (k?.trim() === 'TURSO_AUTH_TOKEN') TURSO_AUTH_TOKEN = v.join('=').trim();
  }
} catch {
  TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
  TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
}

if (!TURSO_DATABASE_URL) {
  console.error('Missing TURSO_DATABASE_URL');
  process.exit(1);
}

const db = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

// ---------------------------------------------------------------------------
// Run migrations inline — ensures all tables exist before seeding
// ---------------------------------------------------------------------------

async function runMigrations() {
  console.log('[migrate] Ensuring schema is up to date...');

  await db.execute(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);

  // inventory_products (Item Type 0 — physical warehouse SKUs)
  await db.execute(`CREATE TABLE IF NOT EXISTS inventory_products (
    sku         TEXT    PRIMARY KEY,
    title       TEXT,
    asin        TEXT,
    upc         TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    image_url   TEXT,
    weight      REAL,
    current_qty INTEGER NOT NULL DEFAULT 0,
    unit_cost   REAL    NOT NULL DEFAULT 0.0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_inv_prod_asin   ON inventory_products (asin)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_inv_prod_active ON inventory_products (active)`);

  // combo_products (Item Type 1 — virtual bundles)
  await db.execute(`CREATE TABLE IF NOT EXISTS combo_products (
    sku        TEXT    PRIMARY KEY,
    title      TEXT,
    asin       TEXT,
    upc        TEXT,
    active     INTEGER NOT NULL DEFAULT 1,
    image_url  TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_combo_prod_asin ON combo_products (asin)`);

  // needs_review_products (Item Type 2 or invalid)
  await db.execute(`CREATE TABLE IF NOT EXISTS needs_review_products (
    sku        TEXT    PRIMARY KEY,
    title      TEXT,
    item_type  TEXT,
    reason     TEXT,
    raw_row    TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);

  // combo_components (recipe: combo → child inventory SKUs)
  await db.execute(`CREATE TABLE IF NOT EXISTS combo_components (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    combo_sku           TEXT    NOT NULL,
    child_inventory_sku TEXT    NOT NULL,
    quantity            INTEGER NOT NULL,
    sequence            INTEGER NOT NULL DEFAULT 1,
    UNIQUE(combo_sku, child_inventory_sku)
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_cc_combo_sku ON combo_components (combo_sku)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_cc_child_sku ON combo_components (child_inventory_sku)`);

  // sku_mappings (marketplace SKU → Teapplix SKU)
  await db.execute(`CREATE TABLE IF NOT EXISTS sku_mappings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source_sku   TEXT    NOT NULL,
    marketplace  TEXT    NOT NULL DEFAULT 'UNKNOWN',
    teapplix_sku TEXT    NOT NULL,
    mapping_type TEXT    NOT NULL DEFAULT 'manual',
    active       INTEGER NOT NULL DEFAULT 1,
    confidence   REAL    NOT NULL DEFAULT 1.0,
    notes        TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_sku, marketplace)
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_sku_map_source   ON sku_mappings (source_sku)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_sku_map_teapplix ON sku_mappings (teapplix_sku)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_sku_map_active   ON sku_mappings (active)`);

  // order_lines
  await db.execute(`CREATE TABLE IF NOT EXISTS order_lines (
    order_line_id         TEXT    PRIMARY KEY,
    customer_order_id     TEXT    NOT NULL,
    order_date            TEXT    NOT NULL,
    marketplace           TEXT,
    raw_storefront_sku    TEXT    NOT NULL,
    resolved_teapplix_sku TEXT,
    resolved_product_type TEXT,
    qty_sold              INTEGER NOT NULL,
    revenue               REAL    NOT NULL,
    mapping_status        TEXT    NOT NULL DEFAULT 'unmapped',
    created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_ol_order_date   ON order_lines (order_date)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_ol_customer_id  ON order_lines (customer_order_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_ol_raw_sku      ON order_lines (raw_storefront_sku)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_ol_resolved_sku ON order_lines (resolved_teapplix_sku)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_ol_map_status   ON order_lines (mapping_status)`);

  // inventory_allocations (physical depletion — inventory SKUs only)
  await db.execute(`CREATE TABLE IF NOT EXISTS inventory_allocations (
    allocation_id         TEXT    PRIMARY KEY,
    order_line_id         TEXT    NOT NULL,
    inventory_sku         TEXT    NOT NULL,
    qty_depleted          INTEGER NOT NULL,
    source_teapplix_sku   TEXT    NOT NULL,
    source_storefront_sku TEXT    NOT NULL,
    allocation_type       TEXT    NOT NULL DEFAULT 'direct',
    created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_ia_order_line_id ON inventory_allocations (order_line_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_ia_inventory_sku ON inventory_allocations (inventory_sku)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_ia_created_at    ON inventory_allocations (created_at)`);

  // unmapped_skus queue — handle both old schema (marketplace_sku) and new schema (raw_storefront_sku)
  // Check if the old table exists with the old column name
  const unmappedInfo = await db.execute(`PRAGMA table_info(unmapped_skus)`);
  const unmappedCols = unmappedInfo.rows.map((r) => r.name);

  if (unmappedCols.length === 0) {
    // Table doesn't exist yet — create fresh
    await db.execute(`CREATE TABLE unmapped_skus (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_storefront_sku TEXT    NOT NULL UNIQUE,
      marketplace        TEXT,
      first_seen_at      TEXT    NOT NULL,
      last_seen_at       TEXT    NOT NULL,
      order_count        INTEGER NOT NULL DEFAULT 1,
      qty_sold           INTEGER NOT NULL DEFAULT 0,
      revenue            REAL    NOT NULL DEFAULT 0,
      status             TEXT    NOT NULL DEFAULT 'pending'
    )`);
  } else if (unmappedCols.includes('marketplace_sku') && !unmappedCols.includes('raw_storefront_sku')) {
    // Old schema — migrate to new schema by recreating the table
    console.log('[migrate] Migrating unmapped_skus to new schema...');
    await db.execute(`ALTER TABLE unmapped_skus RENAME TO unmapped_skus_old`);
    await db.execute(`CREATE TABLE unmapped_skus (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_storefront_sku TEXT    NOT NULL UNIQUE,
      marketplace        TEXT,
      first_seen_at      TEXT    NOT NULL,
      last_seen_at       TEXT    NOT NULL,
      order_count        INTEGER NOT NULL DEFAULT 1,
      qty_sold           INTEGER NOT NULL DEFAULT 0,
      revenue            REAL    NOT NULL DEFAULT 0,
      status             TEXT    NOT NULL DEFAULT 'pending'
    )`);
    // Migrate existing data
    await db.execute(`INSERT INTO unmapped_skus (raw_storefront_sku, first_seen_at, last_seen_at, order_count)
      SELECT marketplace_sku, first_seen, last_seen, occurrence_count FROM unmapped_skus_old`);
    await db.execute(`DROP TABLE unmapped_skus_old`);
    console.log('[migrate] unmapped_skus migrated.');
  } else {
    // Table exists with new schema — add any missing columns
    for (const [col, def] of [
      ['marketplace', 'TEXT'],
      ['qty_sold', 'INTEGER NOT NULL DEFAULT 0'],
      ['revenue', 'REAL NOT NULL DEFAULT 0'],
      ['status', "TEXT NOT NULL DEFAULT 'pending'"],
    ]) {
      if (!unmappedCols.includes(col)) {
        try { await db.execute(`ALTER TABLE unmapped_skus ADD COLUMN ${col} ${def}`); } catch (_) {}
      }
    }
  }
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_unmapped_status ON unmapped_skus (status)`);

  // mapping_errors
  await db.execute(`CREATE TABLE IF NOT EXISTS mapping_errors (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    error_type   TEXT    NOT NULL,
    source_sku   TEXT,
    teapplix_sku TEXT,
    message      TEXT    NOT NULL,
    severity     TEXT    NOT NULL DEFAULT 'error',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_me_error_type ON mapping_errors (error_type)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_me_severity   ON mapping_errors (severity)`);

  // inventory_snapshots
  await db.execute(`CREATE TABLE IF NOT EXISTS inventory_snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sku           TEXT    NOT NULL,
    snapshot_date TEXT    NOT NULL,
    qty_available INTEGER NOT NULL DEFAULT 0
  )`);
  await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_snap_sku_date ON inventory_snapshots (sku, snapshot_date)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_inv_snap_date ON inventory_snapshots (snapshot_date)`);

  console.log('[migrate] Schema ready.\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSku(raw) {
  if (!raw) return '';
  return raw.trim().replace(/^'+/, '').replace(/\s+/g, ' ').trim();
}

function parseCsv(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const result = Papa.parse(content, { header: true, skipEmptyLines: true });
  return result.data;
}

async function batchInsert(sql, argsList, batchSize = 100) {
  for (let i = 0; i < argsList.length; i += batchSize) {
    const chunk = argsList.slice(i, i + batchSize);
    await db.batch(chunk.map((args) => ({ sql, args })));
  }
}

// ---------------------------------------------------------------------------
// Step 1: Import products.csv
// ---------------------------------------------------------------------------

async function importProducts() {
  const rows = parseCsv(join(ROOT, 'products.csv'));
  console.log(`[products] loaded ${rows.length} rows`);

  const inventoryArgs = [];
  const comboArgs = [];
  const reviewArgs = [];

  for (const row of rows) {
    const itemType = String(row['Item Type'] ?? '').trim();
    const rawSku = String(row['Teapplix SKU'] ?? '').trim();
    const sku = normalizeSku(rawSku);

    if (!sku || sku === '#N/A' || sku === 'N/A') {
      reviewArgs.push([
        rawSku || '(empty)',
        String(row['Item Title'] ?? '').trim(),
        itemType,
        'missing or invalid SKU',
        JSON.stringify(row),
      ]);
      continue;
    }

    const title = String(row['Item Title'] ?? '').trim();
    const asin = String(row['Asin'] ?? '').trim();
    const upc = String(row['UPC'] ?? '').trim();
    const active = String(row['Active'] ?? '1').trim() === '1' ? 1 : 0;
    const imageUrl = String(row['Image Small'] ?? '').trim();
    const weight = parseFloat(row['Weight'] ?? '') || null;
    const initialQty = parseInt(row['Initial Qty'] ?? '0', 10) || 0;
    const unitCost = parseFloat(row['Default Price'] ?? '') || 0.0;

    if (itemType === '0') {
      inventoryArgs.push([sku, title, asin, upc, active, imageUrl, weight, initialQty, unitCost]);
    } else if (itemType === '1') {
      comboArgs.push([sku, title, asin, upc, active, imageUrl]);
    } else {
      reviewArgs.push([sku, title, itemType, `Item Type = ${itemType || 'missing'}`, JSON.stringify(row)]);
    }
  }

  console.log(`[products] inventory_products: ${inventoryArgs.length}`);
  console.log(`[products] combo_products: ${comboArgs.length}`);
  console.log(`[products] needs_review: ${reviewArgs.length}`);

  await batchInsert(
    `INSERT INTO inventory_products (sku, title, asin, upc, active, image_url, weight, current_qty, unit_cost, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(sku) DO UPDATE SET
       title = excluded.title, asin = excluded.asin, upc = excluded.upc,
       active = excluded.active, image_url = excluded.image_url,
       weight = excluded.weight, unit_cost = excluded.unit_cost, updated_at = datetime('now')`,
    inventoryArgs
  );

  await batchInsert(
    `INSERT INTO combo_products (sku, title, asin, upc, active, image_url, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(sku) DO UPDATE SET
       title = excluded.title, asin = excluded.asin, upc = excluded.upc,
       active = excluded.active, image_url = excluded.image_url,
       updated_at = datetime('now')`,
    comboArgs
  );

  await batchInsert(
    `INSERT INTO needs_review_products (sku, title, item_type, reason, raw_row)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sku) DO UPDATE SET
       title = excluded.title, item_type = excluded.item_type,
       reason = excluded.reason, raw_row = excluded.raw_row`,
    reviewArgs
  );

  return {
    inventorySkus: new Set(inventoryArgs.map((a) => a[0])),
    comboSkus: new Set(comboArgs.map((a) => a[0])),
  };
}

// ---------------------------------------------------------------------------
// Step 2: Import comboproducts.csv
// ---------------------------------------------------------------------------

async function importComboComponents(inventorySkus, comboSkus) {
  const rows = parseCsv(join(ROOT, 'comboproducts.csv'));
  console.log(`[comboproducts] loaded ${rows.length} rows`);

  const componentArgs = [];
  const errors = [];

  for (const row of rows) {
    const comboSku = normalizeSku(String(row['Teapplix SKU'] ?? ''));
    const childSku = normalizeSku(String(row['ChildSKU'] ?? ''));
    const quantity = parseInt(row['Quantity'] ?? '0', 10);
    const sequence = parseInt(row['Sequence'] ?? '1', 10);

    if (!comboSku || !childSku) {
      errors.push(['invalid_combo_row', comboSku || null, childSku || null,
        `Missing combo_sku or child_sku in row: ${JSON.stringify(row)}`, 'warning']);
      continue;
    }

    if (quantity <= 0) {
      errors.push(['invalid_quantity', comboSku, childSku,
        `Quantity must be > 0, got ${quantity}`, 'error']);
      continue;
    }

    // Validation: combo parent should exist in combo_products
    if (!comboSkus.has(comboSku)) {
      errors.push(['missing_combo_parent', comboSku, null,
        `Combo parent "${comboSku}" not found in combo_products (Item Type 1)`, 'warning']);
      // Still insert the component — the combo may exist in Teapplix but not in our CSV
    }

    // Validation: child should exist in inventory_products
    if (!inventorySkus.has(childSku)) {
      errors.push(['missing_combo_child', comboSku, childSku,
        `Child SKU "${childSku}" not found in inventory_products (Item Type 0)`, 'warning']);
      // Still insert — child may be seeded later via inventory sync
    }

    componentArgs.push([comboSku, childSku, quantity, sequence]);
  }

  console.log(`[comboproducts] components to insert: ${componentArgs.length}`);
  console.log(`[comboproducts] validation issues: ${errors.length}`);

  await batchInsert(
    `INSERT INTO combo_components (combo_sku, child_inventory_sku, quantity, sequence)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(combo_sku, child_inventory_sku) DO UPDATE SET
       quantity = excluded.quantity, sequence = excluded.sequence`,
    componentArgs
  );

  if (errors.length > 0) {
    await batchInsert(
      `INSERT INTO mapping_errors (error_type, source_sku, teapplix_sku, message, severity)
       VALUES (?, ?, ?, ?, ?)`,
      errors
    );
  }
}

// ---------------------------------------------------------------------------
// Step 3: Import mapping.csv into sku_mappings
// ---------------------------------------------------------------------------

async function importMappings(inventorySkus, comboSkus) {
  const rows = parseCsv(join(ROOT, 'mapping.csv'));
  console.log(`[mapping] loaded ${rows.length} rows`);

  const mappingArgs = [];
  const errors = [];
  const seen = new Set();

  for (const row of rows) {
    const rawSource = String(row['Source Item Name'] ?? '').trim();
    const rawTarget = String(row['Teapplix SKU'] ?? '').trim();

    if (!rawSource || !rawTarget) continue;

    // Normalize: strip leading/trailing whitespace, quotes, apostrophes
    const sourceSku = rawSource
      .replace(/^["'\s]+|["'\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const teapplixSku = rawTarget
      .replace(/^["'\s]+|["'\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!sourceSku || !teapplixSku) continue;

    // Dedup: same source_sku + marketplace
    const key = `${sourceSku}|UNKNOWN`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Validate target exists
    if (!inventorySkus.has(teapplixSku) && !comboSkus.has(teapplixSku)) {
      errors.push(['missing_mapping_target', sourceSku, teapplixSku,
        `Mapping target "${teapplixSku}" not found in inventory_products or combo_products`, 'warning']);
      // Still insert the mapping — target may be seeded later
    }

    mappingArgs.push([sourceSku, 'UNKNOWN', teapplixSku, 'csv_import', 1, 1.0, null]);
  }

  console.log(`[mapping] mappings to insert: ${mappingArgs.length}`);
  console.log(`[mapping] validation issues: ${errors.length}`);

  await batchInsert(
    `INSERT INTO sku_mappings (source_sku, marketplace, teapplix_sku, mapping_type, active, confidence, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(source_sku, marketplace) DO UPDATE SET
       teapplix_sku = excluded.teapplix_sku,
       mapping_type = excluded.mapping_type,
       active = excluded.active,
       updated_at = datetime('now')`,
    mappingArgs
  );

  if (errors.length > 0) {
    await batchInsert(
      `INSERT INTO mapping_errors (error_type, source_sku, teapplix_sku, message, severity)
       VALUES (?, ?, ?, ?, ?)`,
      errors
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Teapplix Product Catalog Seeder ===\n');

  await runMigrations();

  const { inventorySkus, comboSkus } = await importProducts();
  await importComboComponents(inventorySkus, comboSkus);
  await importMappings(inventorySkus, comboSkus);

  console.log('\n=== Summary ===');
  const [invCount] = (await db.execute('SELECT COUNT(*) AS n FROM inventory_products')).rows;
  const [comboCount] = (await db.execute('SELECT COUNT(*) AS n FROM combo_products')).rows;
  const [compCount] = (await db.execute('SELECT COUNT(*) AS n FROM combo_components')).rows;
  const [mapCount] = (await db.execute('SELECT COUNT(*) AS n FROM sku_mappings')).rows;
  const [errCount] = (await db.execute('SELECT COUNT(*) AS n FROM mapping_errors')).rows;
  const [reviewCount] = (await db.execute('SELECT COUNT(*) AS n FROM needs_review_products')).rows;

  console.log(`inventory_products:    ${invCount.n}`);
  console.log(`combo_products:        ${comboCount.n}`);
  console.log(`combo_components:      ${compCount.n}`);
  console.log(`sku_mappings:          ${mapCount.n}`);
  console.log(`needs_review:          ${reviewCount.n}`);
  console.log(`mapping_errors:        ${errCount.n}`);
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
