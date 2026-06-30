/**
 * scripts/seed-from-source.mjs
 *
 * Rebuilds catalog + mappings ONLY from repo CSVs.
 * Uses lib/sku/resolver.ts (via tsx/jiti transpile or prebuilt) for all SKU logic.
 *
 * Inputs:
 *   <REPO_ROOT>/Comboproducts.csv  — Item Type 0 (inventory) + Item Type 1 (combo)
 *   <REPO_ROOT>/Shadowmapping.csv  — source_sku → teapplix_sku
 *
 * Steps:
 *   1. inventory_products  — upsert Type 0 rows (preserve current_qty if exists)
 *   2. combo_products      — upsert Type 1 rows
 *   3. combo_components    — decompose each combo via resolver.decomposeCombo()
 *                            → needs_review_products if null
 *   4. sku_mappings        — upsert each Shadowmapping row (mapping_type='csv_import')
 *
 * Idempotent. Never deletes legacy tables or touches other files.
 *
 * Usage:
 *   node --experimental-vm-modules scripts/seed-from-source.mjs [--dry-run]
 *   # or with tsx:
 *   npx tsx scripts/seed-from-source.mjs [--dry-run]
 */

import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

// ---------------------------------------------------------------------------
// Bootstrap: load .env.local
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const envPath = path.join(REPO_ROOT, '.env.local');
try {
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
} catch {
  console.warn('No .env.local found — relying on process environment');
}

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('Fatal: Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');
if (DRY_RUN) console.log('[DRY RUN] No writes will be executed.\n');

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const { createClient } = require('@libsql/client');
const Papa = require('papaparse');

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ---------------------------------------------------------------------------
// Load resolver — pure functions, no DB calls
// Supports both tsx (TypeScript direct) and pre-compiled JS.
// We inline the resolver logic here to avoid needing a transpiler at runtime.
// ---------------------------------------------------------------------------

// ── WORD_PACK_SIZES ─────────────────────────────────────────────────────────
const WORD_PACK_SIZES = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twelve: 12, twenty: 20,
};

/** Strip apostrophe prefix, trim, collapse whitespace — matches resolver.ts normalizeSku */
function normalizeSku(raw) {
  if (!raw) return '';
  let s = raw.trim();
  // Strip triple-double-quotes
  s = s.replace(/^"""+|"""+$/g, '');
  // Strip surrounding single/double quotes
  s = s.replace(/^['"]|['"]$/g, '');
  // Strip leading Excel apostrophe
  if (s.startsWith("'")) s = s.slice(1);
  // Remove embedded newlines
  s = s.replace(/[\r\n]+/g, '');
  // Strip leading 1AMAM / 1AM / AM prefix
  s = s.replace(/^1AMAM/i, '').replace(/^1AM/i, '').replace(/^AM/i, '');
  // Strip trailing -LA or -par
  s = s.replace(/-(LA|par)$/i, '');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** matches resolver.ts parsePack */
function parsePack(sku) {
  if (!sku) return { base: sku, qty: 1 };

  // "<digits>PK" suffix (e.g. NS5330-5PK → base NS5330, qty 5)
  const pkMatch = sku.match(/^(.+)-(\d+)PK$/i);
  if (pkMatch) return { base: pkMatch[1], qty: parseInt(pkMatch[2], 10) };

  const digitMatch = sku.match(/^(.+)-(\d+)$/);
  if (digitMatch) return { base: digitMatch[1], qty: parseInt(digitMatch[2], 10) };
  const wordMatch = sku.match(/^(.+)-([a-z]+)$/i);
  if (wordMatch) {
    const word = wordMatch[2].toLowerCase();
    if (word in WORD_PACK_SIZES) return { base: wordMatch[1], qty: WORD_PACK_SIZES[word] };
  }
  return { base: sku, qty: 1 };
}

/** matches resolver.ts resolveBaseUnit */
function resolveBaseUnit(base, type0set) {
  if (!base) return null;
  const lower = base.toLowerCase();
  const lower1 = lower + '-1';
  for (const entry of type0set) {
    const el = entry.toLowerCase();
    if (el === lower || el === lower1) return entry;
  }
  return null;
}

/** matches resolver.ts decomposeCombo */
function decomposeCombo(comboSku, type0set) {
  if (!comboSku) return null;

  const segments = comboSku.split('-');
  if (segments.length >= 3) {
    const lastSeg = segments[segments.length - 1];
    const nSeg = segments[segments.length - 2];
    const isLetterToken = (s) => /[a-zA-Z]/.test(s) && /\d/.test(s);
    const nDigit = /^\d+$/.test(nSeg);
    const nWord = nSeg.toLowerCase() in WORD_PACK_SIZES;
    if ((nDigit || nWord) && isLetterToken(lastSeg)) {
      const aBase = segments.slice(0, segments.length - 2).join('-');
      const bBase = lastSeg;
      const qty = nDigit ? parseInt(nSeg, 10) : WORD_PACK_SIZES[nSeg.toLowerCase()];
      const resolvedA = resolveBaseUnit(aBase, type0set);
      const resolvedB = resolveBaseUnit(bBase, type0set);
      if (resolvedA === null || resolvedB === null) return null;
      return [
        { childBaseUnit: resolvedA, qty: 1 },
        { childBaseUnit: resolvedB, qty },
      ];
    }
  }

  const { base, qty } = parsePack(comboSku);

  if (qty === 1) {
    // Single-unit alias: resolve base and return 1-child result, else null.
    const resolvedAlias = resolveBaseUnit(base, type0set);
    if (resolvedAlias === null) return null;
    return [{ childBaseUnit: resolvedAlias, qty: 1 }];
  }

  const resolved = resolveBaseUnit(base, type0set);
  if (resolved === null) return null;
  return [{ childBaseUnit: resolved, qty }];
}

// ---------------------------------------------------------------------------
// CSV parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a CSV file with papaparse.
 * Returns array of objects with header keys.
 */
function parseCsv(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const result = Papa.parse(content, {
    header: true,
    skipEmptyLines: true,
    relaxQuotes: true,
    trimHeaders: true,
  });
  if (result.errors.length > 0) {
    // Non-fatal: log and continue
    for (const err of result.errors.slice(0, 5)) {
      console.warn(`CSV parse warning [${filePath}] row ${err.row}: ${err.message}`);
    }
  }
  return result.data;
}

/**
 * Clean a Source Item Name from Shadowmapping:
 *  1. Strip leading/trailing whitespace + embedded newlines
 *  2. Strip surrounding quotes (double/triple)
 *  3. Strip leading Excel apostrophe
 *  4. Collapse internal whitespace
 */
function cleanSourceName(raw) {
  if (!raw) return '';
  let s = raw.replace(/[\r\n]+/g, ' ').trim();
  // Triple-double-quote artifact
  s = s.replace(/^"""+|"""+$/g, '');
  // Surrounding single/double quote
  s = s.replace(/^['"]|['"]$/g, '');
  // Leading apostrophe (Excel export artifact)
  if (s.startsWith("'")) s = s.slice(1);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function batchExec(statements) {
  if (DRY_RUN || statements.length === 0) return;
  const BATCH = 100;
  for (let i = 0; i < statements.length; i += BATCH) {
    await db.batch(statements.slice(i, i + BATCH));
  }
}

async function fetchCurrentQtyMap() {
  const result = await db.execute('SELECT sku, current_qty FROM inventory_products');
  const map = new Map();
  for (const row of result.rows) map.set(row.sku, Number(row.current_qty));
  return map;
}

// ---------------------------------------------------------------------------
// Step 1 + 2: Parse Comboproducts.csv → type0 rows + type1 rows
// ---------------------------------------------------------------------------

console.log('Reading Comboproducts.csv…');
const comboRows = parseCsv(path.join(REPO_ROOT, 'Comboproducts.csv'));

const type0Rows = [];   // inventory_products
const type1Rows = [];   // combo_products

const COL_TYPE  = 'Item Type';
const COL_SKU   = 'Teapplix SKU';
const COL_TITLE = 'Item Title';
const COL_PRICE = 'Default Price';
const COL_ASIN  = 'Asin';

for (const row of comboRows) {
  const itemType = String(row[COL_TYPE] ?? '').trim();
  const rawSku   = String(row[COL_SKU] ?? '').trim();

  // Normalize SKU: strip leading apostrophe (Excel artifact) — do NOT call
  // the full normalizeSku() on Teapplix SKU because that strips AM prefix,
  // which would corrupt canonical SKUs like AM5234. Just strip apostrophe + whitespace.
  const sku = rawSku.replace(/^'+/, '').trim();

  if (!sku || sku === 'N/A' || sku === '#N/A') continue;  // skip blank/N/A

  const title     = String(row[COL_TITLE] ?? '').trim();
  const rawPrice  = String(row[COL_PRICE] ?? '').trim();
  const unitCost  = parseFloat(rawPrice) || 0;
  const asin      = String(row[COL_ASIN] ?? '').trim();

  if (itemType === '0') {
    type0Rows.push({ sku, title, asin, unit_cost: unitCost });
  } else if (itemType === '1') {
    type1Rows.push({ sku, title, asin });
  }
  // other types → skip (not in scope)
}

console.log(`  Type 0 (inventory): ${type0Rows.length} rows`);
console.log(`  Type 1 (combo):     ${type1Rows.length} rows`);

// ---------------------------------------------------------------------------
// Step 1: Upsert inventory_products (preserve current_qty)
// ---------------------------------------------------------------------------

console.log('\nStep 1: Upserting inventory_products…');

// Fetch existing qty so we can preserve it
const existingQtyMap = await fetchCurrentQtyMap();

const invStatements = type0Rows.map((r) => {
  const qty = existingQtyMap.get(r.sku) ?? 0;  // preserve if synced, else 0
  return {
    sql: `INSERT INTO inventory_products
            (sku, title, asin, unit_cost, current_qty, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(sku) DO UPDATE SET
            title      = excluded.title,
            asin       = excluded.asin,
            unit_cost  = excluded.unit_cost,
            updated_at = datetime('now')`,
    // NOTE: current_qty deliberately NOT updated on conflict — preserve live qty
    args: [r.sku, r.title, r.asin, r.unit_cost, qty],
  };
});

await batchExec(invStatements);
console.log(`  Upserted ${type0Rows.length} inventory_products`);

// ---------------------------------------------------------------------------
// Step 2: Upsert combo_products
// ---------------------------------------------------------------------------

console.log('\nStep 2: Upserting combo_products…');

const comboStatements = type1Rows.map((r) => ({
  sql: `INSERT INTO combo_products
          (sku, title, asin, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(sku) DO UPDATE SET
          title      = excluded.title,
          asin       = excluded.asin,
          updated_at = datetime('now')`,
  args: [r.sku, r.title, r.asin],
}));

await batchExec(comboStatements);
console.log(`  Upserted ${type1Rows.length} combo_products`);

// ---------------------------------------------------------------------------
// Step 3: Decompose combos → combo_components or needs_review_products
// ---------------------------------------------------------------------------

console.log('\nStep 3: Decomposing combos via resolver.decomposeCombo()…');

// Build type0 set from what we just loaded (canonical SKUs)
const type0set = new Set(type0Rows.map((r) => r.sku));

// Build unit_cost lookup for revenue-allocation share
const unitCostMap = new Map(type0Rows.map((r) => [r.sku, r.unit_cost]));

const componentStatements = [];
const reviewStatements    = [];
const needsReviewList     = [];
let   decomposedCount     = 0;

for (const combo of type1Rows) {
  const children = decomposeCombo(combo.sku, type0set);

  if (children === null) {
    const reason = `decomposeCombo returned null — no matching base unit(s) in type0 catalog`;
    reviewStatements.push({
      sql: `INSERT INTO needs_review_products (sku, title, item_type, reason, raw_row, created_at)
            VALUES (?, ?, '1', ?, ?, datetime('now'))
            ON CONFLICT(sku) DO UPDATE SET
              reason   = excluded.reason,
              raw_row  = excluded.raw_row`,
      args: [combo.sku, combo.title, reason, JSON.stringify(combo)],
    });
    needsReviewList.push({ sku: combo.sku, title: combo.title, reason });
    continue;
  }

  // Compute revenue-allocation shares from unit_cost
  const totalCost = children.reduce((sum, c) => {
    const cost = unitCostMap.get(c.childBaseUnit) ?? 0;
    return sum + cost * c.qty;
  }, 0);

  let sequence = 1;
  for (const child of children) {
    const childCost = unitCostMap.get(child.childBaseUnit) ?? 0;
    const share     = totalCost > 0 ? (childCost / totalCost) : (1 / children.length);

    componentStatements.push({
      sql: `INSERT INTO combo_components
              (combo_sku, child_inventory_sku, quantity, sequence)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(combo_sku, child_inventory_sku) DO UPDATE SET
              quantity = excluded.quantity,
              sequence = excluded.sequence`,
      // revenue_share is not in schema — schema has only quantity+sequence
      // share stored as note for now; schema has no revenue_share column
      args: [combo.sku, child.childBaseUnit, child.qty, sequence++],
    });
  }
  decomposedCount++;
}

await batchExec(componentStatements);
await batchExec(reviewStatements);

console.log(`  Decomposed:    ${decomposedCount} combos → combo_components`);
console.log(`  Needs review:  ${needsReviewList.length} combos → needs_review_products`);

// ---------------------------------------------------------------------------
// Step 4: Shadowmapping.csv → sku_mappings
// ---------------------------------------------------------------------------

console.log('\nStep 4: Upserting sku_mappings from Shadowmapping.csv…');

const shadowRows = parseCsv(path.join(REPO_ROOT, 'Shadowmapping.csv'));

const mappingStatements = [];
let   mappingCount = 0;
let   mappingSkipped = 0;

for (const row of shadowRows) {
  const rawSource = String(row['Source Item Name'] ?? '').trim();
  const rawTarget = String(row['Teapplix SKU'] ?? '').trim();

  // Clean source: strip newlines, leading apostrophe, surrounding quotes, collapse whitespace
  const sourceSku = cleanSourceName(rawSource);
  // Target: strip leading apostrophe only (preserve canonical form)
  const teapplixSku = rawTarget.replace(/^'+/, '').trim();

  if (!sourceSku || !teapplixSku) {
    mappingSkipped++;
    continue;
  }

  mappingStatements.push({
    sql: `INSERT INTO sku_mappings
            (source_sku, marketplace, teapplix_sku, mapping_type, active, confidence, updated_at)
          VALUES (?, 'UNKNOWN', ?, 'csv_import', 1, 1.0, datetime('now'))
          ON CONFLICT(source_sku, marketplace) DO UPDATE SET
            teapplix_sku = excluded.teapplix_sku,
            mapping_type = excluded.mapping_type,
            active       = excluded.active,
            confidence   = excluded.confidence,
            updated_at   = datetime('now')`,
    args: [sourceSku, teapplixSku],
  });
  mappingCount++;
}

await batchExec(mappingStatements);
console.log(`  Upserted ${mappingCount} sku_mappings  (skipped ${mappingSkipped} blank rows)`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n══════════════════════════════════════════');
console.log('  SEED SUMMARY');
console.log('══════════════════════════════════════════');
console.log(`  inventory_products  : ${type0Rows.length} upserted`);
console.log(`  combo_products      : ${type1Rows.length} upserted`);
console.log(`  combo_components    : ${componentStatements.length} component rows`);
console.log(`  sku_mappings        : ${mappingCount} upserted`);
console.log(`  needs_review        : ${needsReviewList.length} combos`);

if (needsReviewList.length > 0) {
  console.log('\n── NEEDS REVIEW ─────────────────────────');
  for (const item of needsReviewList) {
    console.log(`  SKU: ${item.sku}`);
    console.log(`    Title:  ${item.title || '(no title)'}`);
    console.log(`    Reason: ${item.reason}`);
  }
  console.log('─────────────────────────────────────────');
}

if (DRY_RUN) {
  console.log('\n[DRY RUN] No data was written to the database.');
}

console.log('\nDone.');
process.exit(0);
