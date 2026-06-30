/**
 * scripts/reprocess-history.ts
 *
 * Re-processes up to 36 months of Teapplix order history through the REAL
 * buildIngestRows pipeline (imported from lib/db/queries.ts — same code as
 * live ingestion).
 *
 * Run via jiti so TypeScript + @/ path aliases resolve:
 *   node -r jiti/register scripts/reprocess-history.ts [--last3 | --full [--resume]]
 *
 * MODES
 *   --last3     Last 3 calendar months only. Idempotent (delete-then-insert).
 *               Shows per-month summary + unmapped/errors. NO full-run coverage table.
 *               Use this for a dry-preview before committing to --full.
 *   --full      Process full 36-month window, NEWEST first.
 *   --resume    Same as --full but skip months already in checkpoint.
 *
 * CHUNK SIZE: one calendar month at a time. Per month:
 *   1. Fetch that month's orders from Teapplix (paginated).
 *   2. Run through real buildIngestRows.
 *   3. DELETE that month's inventory_allocations rows.
 *   4. INSERT corrected allocation rows (direct / combo_explode).
 *   5. UPSERT order_lines for that month.
 *   6. Route unmapped raw SKUs to unmapped_skus.
 *   7. Mark month complete in checkpoint.
 *
 * CHECKPOINT: stored in sync_status id='reprocess', detail = JSON.
 *   { completedMonths: ["2023-06", "2023-07", ...] }
 *
 * Never touches: orders, order_item_allocations, inventory_products,
 * combo_products, combo_components, sku_mappings, mapping_errors.
 */

import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

// Real pipeline — same code as live ingestion
import {
  buildIngestRows,
  type RawOrderItem,
  type AllocationRow,
  type OrderLineRow,
  type ComboComponentRow,
} from '@/lib/db/queries';

// Real resolver — same normalizeSku used by buildIngestRows internally
import { normalizeSku } from '@/lib/sku/resolver';

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TURSO_URL      = process.env.TURSO_DATABASE_URL!;
const TURSO_TOKEN    = process.env.TURSO_AUTH_TOKEN!;
const TEAPPLIX_TOKEN = process.env.TEAPPLIX_API_TOKEN!;
const TZ             = process.env.BUSINESS_TIMEZONE ?? 'America/Los_Angeles';
const BASE_API       = 'https://api.teapplix.com/api2';
const WINDOW_MONTHS  = 36;
const INTER_MONTH_DELAY_MS = 500;

const args       = process.argv.slice(2);
const IS_LAST3   = args.includes('--last3');
const IS_FULL    = args.includes('--full');
const IS_RESUME  = args.includes('--resume');

if (!IS_LAST3 && !IS_FULL) {
  console.error('Usage: node -r jiti/register scripts/reprocess-history.ts [--last3 | --full [--resume]]');
  console.error('  --last3   Preview: reprocess last 3 months only, print per-month summary, stop for approval.');
  console.error('  --full    Full 36-month run, newest-first, idempotent.');
  console.error('  --resume  With --full: skip months already in checkpoint.');
  process.exit(1);
}
if (!TURSO_URL || !TURSO_TOKEN || !TEAPPLIX_TOKEN) {
  console.error('Missing env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, TEAPPLIX_API_TOKEN');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ---------------------------------------------------------------------------
// DB lookup loaders — mirrors buildSyncLookups from queries.ts exactly
// ---------------------------------------------------------------------------

interface Checkpoint { completedMonths: string[]; }

async function loadLookups() {
  const [mappingsRes, comboCompRes, invRes, comboRes] = await db.batch([
    { sql: `SELECT source_sku, teapplix_sku FROM sku_mappings WHERE active = 1`, args: [] },
    { sql: `SELECT combo_sku, child_inventory_sku, quantity, sequence FROM combo_components ORDER BY combo_sku, sequence`, args: [] },
    { sql: `SELECT sku FROM inventory_products`, args: [] },
    { sql: `SELECT sku FROM combo_products WHERE active = 1`, args: [] },
  ]);

  const mappingLookup = new Map<string, string>();
  for (const r of mappingsRes.rows) {
    const src = String(r.source_sku);
    const tgt = String(r.teapplix_sku);
    mappingLookup.set(src, tgt);
    const lower = src.toLowerCase().trim();
    if (!mappingLookup.has(lower)) mappingLookup.set(lower, tgt);
  }

  const comboLookup = new Map<string, ComboComponentRow[]>();
  for (const r of comboCompRes.rows) {
    const sku  = String(r.combo_sku);
    const list = comboLookup.get(sku) ?? [];
    list.push({ combo_sku: sku, child_inventory_sku: String(r.child_inventory_sku), quantity: Number(r.quantity), sequence: Number(r.sequence) });
    comboLookup.set(sku, list);
  }

  const inventorySkuSet = new Set<string>(invRes.rows.map(r => String(r.sku)));
  const comboSkuSet     = new Set<string>(comboRes.rows.map(r => String(r.sku)));

  return { mappingLookup, comboLookup, inventorySkuSet, comboSkuSet };
}

// ---------------------------------------------------------------------------
// Teapplix fetch helpers
// ---------------------------------------------------------------------------
async function fetchWithRetry(url: string, attempt = 1): Promise<Response> {
  const res = await fetch(url, { headers: { APIToken: TEAPPLIX_TOKEN }, cache: 'no-store' });
  if ((res.status === 503 || res.status === 429) && attempt < 5) {
    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
    console.warn(`  [retry] HTTP ${res.status}, waiting ${delay}ms (attempt ${attempt})...`);
    await new Promise(r => setTimeout(r, delay));
    return fetchWithRetry(url, attempt + 1);
  }
  return res;
}

async function fetchMonthOrders(startDate: string, endDate: string) {
  const allOrders: any[] = [];
  let seqStart: number | null = null;

  while (true) {
    const url = new URL(`${BASE_API}/OrderNotification`);
    url.searchParams.set('PaymentDateStart', startDate);
    url.searchParams.set('PaymentDateEnd',   endDate);
    if (seqStart !== null) url.searchParams.set('SeqStart', String(seqStart));

    const res = await fetchWithRetry(url.toString());
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Teapplix ${res.status}: ${body}`);
    }

    const data   = await res.json() as any;
    const orders = (data.Orders ?? []) as any[];
    allOrders.push(...orders);

    const p = data.Pagination;
    if (p && p.PageNumber < p.TotalPages) {
      seqStart = parseInt(orders[orders.length - 1].SeqNumber, 10) + 1;
    } else {
      break;
    }
  }
  return allOrders;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function todayInTz(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function monthStart(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

function monthEnd(year: number, month: number): string {
  const d = new Date(year, month, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Build month windows for numMonths ending with the current month.
 * Returns array ordered NEWEST-FIRST (index 0 = current month).
 */
function buildMonthWindows(numMonths: number) {
  const today  = new Date(todayInTz());
  const months = [];
  // i=0 → current month, i=1 → one month ago, etc. (newest-first)
  for (let i = 0; i < numMonths; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    months.push({
      label:     `${y}-${String(m).padStart(2, '0')}`,
      startDate: monthStart(y, m),
      endDate:   monthEnd(y, m),
    });
  }
  return months; // newest-first
}

// ---------------------------------------------------------------------------
// Convert Teapplix orders → RawOrderItem[]
// ---------------------------------------------------------------------------
function toRawItems(orders: any[], startDate: string, endDate: string): RawOrderItem[] {
  const items: RawOrderItem[] = [];
  for (const order of orders) {
    const paymentDate = (order.OrderDetails?.PaymentDate ?? '').slice(0, 10);
    if (paymentDate < startDate || paymentDate > endDate) continue;
    for (let i = 0; i < (order.OrderItems ?? []).length; i++) {
      const item           = order.OrderItems[i];
      const marketplace_sku = (item.Name ?? '').trim();
      if (!marketplace_sku) continue;
      items.push({
        marketplace_sku,
        order_id:    order.TxnId,
        order_date:  paymentDate,
        marketplace: order.StoreType ?? 'UNKNOWN',
        qty:         item.Quantity,
        total_price: item.Amount,
        line_number: i,
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Checkpoint helpers
// ---------------------------------------------------------------------------
async function loadCheckpoint(): Promise<Checkpoint> {
  try {
    const r = await db.execute(`SELECT detail FROM sync_status WHERE id = 'reprocess' LIMIT 1`);
    if (r.rows.length === 0) return { completedMonths: [] };
    return JSON.parse((r.rows[0].detail as string) ?? '{"completedMonths":[]}');
  } catch {
    return { completedMonths: [] };
  }
}

async function saveCheckpoint(cp: Checkpoint): Promise<void> {
  await db.execute({
    sql: `INSERT INTO sync_status (id, phase, detail, done, updated_at)
          VALUES ('reprocess', 'reprocess:running', ?, 0, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            phase      = 'reprocess:running',
            detail     = excluded.detail,
            updated_at = excluded.updated_at`,
    args: [JSON.stringify(cp)],
  });
}

async function markCheckpointDone(): Promise<void> {
  await db.execute({
    sql: `UPDATE sync_status SET phase = 'reprocess:done', done = 1, updated_at = datetime('now')
          WHERE id = 'reprocess'`,
    args: [],
  });
}

// ---------------------------------------------------------------------------
// DB write helpers
// ---------------------------------------------------------------------------
async function deleteMonthAllocations(startDate: string, endDate: string): Promise<void> {
  await db.execute({
    sql: `DELETE FROM inventory_allocations
          WHERE order_line_id IN (
            SELECT order_line_id FROM order_lines
            WHERE order_date >= ? AND order_date <= ?
          )`,
    args: [startDate, endDate],
  });
}

async function upsertOrderLines(rows: OrderLineRow[]): Promise<void> {
  if (rows.length === 0) return;
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(chunk.map(r => ({
      sql: `INSERT OR REPLACE INTO order_lines
              (order_line_id, customer_order_id, order_date, marketplace,
               raw_storefront_sku, resolved_teapplix_sku, resolved_product_type,
               qty_sold, revenue, mapping_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        r.order_line_id, r.customer_order_id, r.order_date, r.marketplace,
        r.raw_storefront_sku, r.resolved_teapplix_sku ?? null, r.resolved_product_type ?? null,
        r.qty_sold, r.revenue, r.mapping_status,
      ],
    })));
  }
}

async function insertAllocationRows(rows: AllocationRow[]): Promise<void> {
  if (rows.length === 0) return;
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(chunk.map(r => ({
      sql: `INSERT OR REPLACE INTO inventory_allocations
              (allocation_id, order_line_id, inventory_sku, qty_depleted,
               source_teapplix_sku, source_storefront_sku, allocation_type)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        r.allocation_id, r.order_line_id, r.inventory_sku, r.qty_depleted,
        r.source_teapplix_sku, r.source_storefront_sku, r.allocation_type,
      ],
    })));
  }
}

async function upsertUnmappedSkus(
  skus: string[], dateStr: string, rawItems: RawOrderItem[]
): Promise<void> {
  if (skus.length === 0) return;
  for (const sku of skus) {
    const items   = rawItems.filter(i => i.marketplace_sku === sku);
    const qty     = items.reduce((s, i) => s + i.qty, 0);
    const revenue = items.reduce((s, i) => s + i.total_price, 0);
    await db.execute({
      sql: `INSERT INTO unmapped_skus
              (raw_storefront_sku, marketplace, first_seen_at, last_seen_at, order_count, qty_sold, revenue, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
            ON CONFLICT(raw_storefront_sku) DO UPDATE SET
              last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
              order_count  = order_count + excluded.order_count,
              qty_sold     = qty_sold    + excluded.qty_sold,
              revenue      = revenue     + excluded.revenue`,
      args: [sku, items[0]?.marketplace ?? 'UNKNOWN', dateStr, dateStr, items.length, qty, revenue],
    });
  }
}

// ---------------------------------------------------------------------------
// Print helpers
// ---------------------------------------------------------------------------
function printMonthSummary(
  label: string,
  ordersCount: number,
  allocsCount: number,
  baseUnits: number,
  unmappedSkus: string[],
  mappingErrors: string[],
) {
  const hdr = `  [${label}]`;
  console.log(`${hdr} orders=${ordersCount}  allocs=${allocsCount}  base_units=${baseUnits}  unmapped_skus=${unmappedSkus.length}  mapping_errors=${mappingErrors.length}`);
  if (unmappedSkus.length > 0) {
    console.log(`           unmapped_skus → unmapped_skus table: ${unmappedSkus.slice(0, 10).join(', ')}${unmappedSkus.length > 10 ? ` … (+${unmappedSkus.length - 10} more)` : ''}`);
  }
  if (mappingErrors.length > 0) {
    console.log(`           mapping_errors (target SKU missing): ${mappingErrors.slice(0, 10).join(', ')}${mappingErrors.length > 10 ? ` … (+${mappingErrors.length - 10} more)` : ''}`);
  }
}

async function printCoverageTable(months: { label: string; startDate: string; endDate: string }[]) {
  console.log('\n' + '='.repeat(72));
  console.log('36-MONTH COVERAGE TABLE (newest first)');
  console.log('='.repeat(72));
  console.log(
    '  ' + 'month'.padEnd(10) +
    'order_lines'.padStart(14) +
    'alloc_rows'.padStart(12) +
    'base_units'.padStart(12)
  );
  console.log('  ' + '-'.repeat(48));

  for (const win of months) {
    const res = await db.execute({
      sql: `SELECT
              COUNT(DISTINCT ol.order_line_id)  AS ol_count,
              COUNT(ia.allocation_id)           AS ia_count,
              COALESCE(SUM(ia.qty_depleted), 0) AS base_units
            FROM order_lines ol
            LEFT JOIN inventory_allocations ia ON ia.order_line_id = ol.order_line_id
            WHERE ol.order_date >= ? AND ol.order_date <= ?`,
      args: [win.startDate, win.endDate],
    });
    const row = res.rows[0];
    const olCount  = Number(row?.ol_count  ?? 0);
    const iaCount  = Number(row?.ia_count  ?? 0);
    const baseUnits= Number(row?.base_units ?? 0);
    const gap = olCount === 0 ? '  ← GAP' : '';
    console.log(
      '  ' + win.label.padEnd(10) +
      String(olCount).padStart(14) +
      String(iaCount).padStart(12) +
      String(baseUnits).padStart(12) +
      gap
    );
  }
  console.log('='.repeat(72) + '\n');
}

// ---------------------------------------------------------------------------
// Core: process one month (used by both --last3 and --full)
// ---------------------------------------------------------------------------
async function processMonth(
  win: { label: string; startDate: string; endDate: string },
  lookups: Awaited<ReturnType<typeof loadLookups>>,
  checkpoint: Checkpoint,
  isResume: boolean,
  isDryPreview: boolean,
): Promise<void> {
  const { label, startDate, endDate } = win;

  if (isResume && checkpoint.completedMonths.includes(label)) {
    console.log(`  [SKIP] ${label} already completed`);
    return;
  }

  process.stdout.write(`  [${label}] Fetching ${startDate} → ${endDate} ... `);
  const orders   = await fetchMonthOrders(startDate, endDate);
  const rawItems = toRawItems(orders, startDate, endDate);
  console.log(`${orders.length} orders, ${rawItems.length} lines`);

  const { orderLineRows, allocationRows, unmappedSkus, mappingErrors } = buildIngestRows(
    rawItems,
    lookups.mappingLookup,
    lookups.comboLookup,
    lookups.inventorySkuSet,
    lookups.comboSkuSet,
  );

  const baseUnits = allocationRows.reduce((s, r) => s + r.qty_depleted, 0);

  await deleteMonthAllocations(startDate, endDate);
  await upsertOrderLines(orderLineRows);
  await insertAllocationRows(allocationRows);

  if (unmappedSkus.length > 0) {
    await upsertUnmappedSkus(unmappedSkus, startDate, rawItems);
  }

  printMonthSummary(label, orders.length, allocationRows.length, baseUnits, unmappedSkus, mappingErrors);

  if (!isDryPreview) {
    checkpoint.completedMonths.push(label);
    await saveCheckpoint(checkpoint);
  }
}

// ---------------------------------------------------------------------------
// --last3: process last 3 months, print summary, stop for approval
// ---------------------------------------------------------------------------
async function runLast3(lookups: Awaited<ReturnType<typeof loadLookups>>) {
  // newest-first, take 3
  const months = buildMonthWindows(3);

  console.log(`\n=== LAST-3 PREVIEW: ${months[months.length - 1].label} → ${months[0].label} ===`);
  console.log('Writes are live (delete-then-insert, idempotent). Newest month first.\n');

  for (const win of months) {
    try {
      await processMonth(win, lookups, { completedMonths: [] }, false, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [${win.label}] FAILED: ${msg}`);
    }
    await new Promise(r => setTimeout(r, INTER_MONTH_DELAY_MS));
  }

  // Mini coverage table for just these 3 months
  console.log('\n--- 3-MONTH COVERAGE CHECK ---');
  await printCoverageTable(months);

  console.log('=== LAST-3 PREVIEW COMPLETE ===');
  console.log('Review output above. If good, run with --full [--resume] for all 36 months.\n');
}

// ---------------------------------------------------------------------------
// --full: process all 36 months newest-first
// ---------------------------------------------------------------------------
async function runFull(lookups: Awaited<ReturnType<typeof loadLookups>>) {
  // newest-first
  const months     = buildMonthWindows(WINDOW_MONTHS);
  const checkpoint = IS_RESUME ? await loadCheckpoint() : { completedMonths: [] };

  console.log(`\n=== FULL RUN: ${months[0].label} → ${months[months.length - 1].label} (${months.length} months, newest-first) ===`);
  if (IS_RESUME) console.log(`  Resuming — ${checkpoint.completedMonths.length} months already done`);
  console.log('');

  let processed = 0;
  let errors    = 0;

  for (const win of months) {
    try {
      await processMonth(win, lookups, checkpoint, IS_RESUME, false);
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [${win.label}] FAILED: ${msg}`);
      errors++;
    }
    await new Promise(r => setTimeout(r, INTER_MONTH_DELAY_MS));
  }

  await markCheckpointDone();

  console.log(`\n=== Full run done ===`);
  console.log(`  Months processed : ${processed}`);
  console.log(`  Errors (skipped) : ${errors}`);
  if (errors > 0) console.log(`  Re-run with --full --resume to retry failed months.`);

  await printCoverageTable(months);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('Loading DB lookups...');
  const lookups = await loadLookups();
  console.log(`  ${lookups.mappingLookup.size} sku_mappings, ${lookups.comboLookup.size} combo recipes, ${lookups.inventorySkuSet.size} inventory SKUs, ${lookups.comboSkuSet.size} combo SKUs`);

  if (IS_LAST3) {
    await runLast3(lookups);
  } else {
    await runFull(lookups);
  }
}

main().catch(err => {
  console.error('\nFatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
