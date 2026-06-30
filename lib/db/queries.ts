import { getDb } from './turso';
import { getOrgContext, runWithOrg } from './context';
import { DailySummary, SkuRecord } from '../data/types';
import { getFamilySku } from '../sku';
import { parsePack, resolveBaseUnit, normalizeSku as resolverNormalizeSku } from '../sku/resolver';
import { encrypt, decrypt } from '../crypto';

// In-memory caches for restock plan calculations
let restockPlanCache: { data: any; timestamp: number } | null = null;
/** @deprecated seasonal cache removed — unified planner replaces it */
let seasonalRestockCache: { data: any; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Bust cache on module load (handles hot-reload / code changes)
restockPlanCache = null;

export function clearRestockCaches() {
  restockPlanCache = null;
  seasonalRestockCache = null;
}


// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE ?? 'America/Los_Angeles';

export function getTodayInTz(tz = BUSINESS_TZ): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

export function getDateNDaysAgoInTz(n: number, tz = BUSINESS_TZ): string {
  // Compute "today" in the business timezone first, then subtract n days.
  // Use noon UTC (12:00) of the target date to avoid DST/timezone boundary
  // issues where midnight UTC rolls back to the previous day in western timezones.
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const [year, month, day] = todayStr.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day - n, 12, 0, 0));
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
}

// ---------------------------------------------------------------------------
// Batched sync lookups — single round-trip for all 4 catalog/mapping reads
// ---------------------------------------------------------------------------

/**
 * Build all four in-memory lookups needed by the sync pipeline in ONE Turso
 * batch call (4 SELECTs → 1 network round-trip instead of 4).
 *
 * Returns the same shapes as the individual helpers so callers need no changes.
 */
export async function buildSyncLookups(): Promise<{
  mappingLookup: Map<string, string>;
  comboLookup: Map<string, ComboComponentRow[]>;
  inventoryProductMap: Map<string, InventoryProductRow>;
  comboSkuSet: Set<string>;
}> {
  const db = getDb();

  const [mappingsResult, comboComponentsResult, inventoryResult, comboResult] =
    await db.batch([
      { sql: `SELECT source_sku, teapplix_sku FROM sku_mappings WHERE active = 1`, args: [] },
      { sql: `SELECT combo_sku, child_inventory_sku, quantity, sequence FROM combo_components ORDER BY combo_sku, sequence`, args: [] },
      { sql: `SELECT sku, title, asin, upc, active, image_url, weight, current_qty, updated_at FROM inventory_products`, args: [] },
      { sql: `SELECT sku FROM combo_products WHERE active = 1`, args: [] },
    ]);

  // mappingLookup: exact + lowercase
  const mappingLookup = new Map<string, string>();
  for (const r of mappingsResult.rows) {
    const src = r.source_sku as string;
    const tgt = r.teapplix_sku as string;
    mappingLookup.set(src, tgt);
    const lower = src.toLowerCase().trim();
    if (!mappingLookup.has(lower)) mappingLookup.set(lower, tgt);
  }

  // comboLookup: combo_sku → components[]
  const comboLookup = new Map<string, ComboComponentRow[]>();
  for (const r of comboComponentsResult.rows) {
    const sku = r.combo_sku as string;
    const qty = Number(r.quantity);
    const list = comboLookup.get(sku) ?? [];
    list.push({
      combo_sku: sku,
      child_inventory_sku: r.child_inventory_sku as string,
      quantity: qty,
      sequence: Number(r.sequence),
    });
    comboLookup.set(sku, list);
  }

  // inventoryProductMap: sku → row
  const inventoryProductMap = new Map<string, InventoryProductRow>();
  for (const r of inventoryResult.rows) {
    const sku = r.sku as string;
    inventoryProductMap.set(sku, {
      sku,
      title: (r.title as string) ?? '',
      asin: (r.asin as string) ?? '',
      upc: (r.upc as string) ?? '',
      active: Number(r.active),
      image_url: (r.image_url as string) ?? '',
      weight: r.weight != null ? Number(r.weight) : null,
      current_qty: Number(r.current_qty),
      updated_at: (r.updated_at as string) ?? undefined,
    });
  }

  // comboSkuSet
  const comboSkuSet = new Set<string>(comboResult.rows.map((r) => r.sku as string));

  return { mappingLookup, comboLookup, inventoryProductMap, comboSkuSet };
}

// ---------------------------------------------------------------------------
// SKU normalization
// Normalizes whitespace, apostrophe prefixes, and case for safe comparison.
// Does NOT strip pack suffixes — that is handled by the mapping table.
// ---------------------------------------------------------------------------

export function normalizeSku(raw: string): string {
  if (!raw) return '';
  return raw
    .trim()
    .replace(/^'+/, '')          // strip leading apostrophes (Excel artifacts)
    .replace(/\s+/g, ' ')        // collapse internal whitespace
    .trim();
}

/**
 * Legacy canonicalizeSku — kept for backward compat with old inventory-sync route.
 * New code should use normalizeSku() + the mapping table instead.
 * @deprecated
 */
export function canonicalizeSku(raw: string): string {
  return normalizeSku(raw);
}


// ---------------------------------------------------------------------------
// Product Catalog — inventory_products
// ---------------------------------------------------------------------------

export interface InventoryProductRow {
  sku: string;
  title: string;
  asin: string;
  upc: string;
  active: number;
  image_url: string;
  weight: number | null;
  current_qty: number;
  updated_at?: string;
}

export async function upsertInventoryProducts(rows: InventoryProductRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO inventory_products
                (sku, title, asin, upc, active, image_url, weight, current_qty, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(sku) DO UPDATE SET
                title       = excluded.title,
                asin        = excluded.asin,
                upc         = excluded.upc,
                active      = excluded.active,
                image_url   = excluded.image_url,
                weight      = excluded.weight,
                current_qty = excluded.current_qty,
                updated_at  = datetime('now')`,
        args: [r.sku, r.title, r.asin, r.upc, r.active, r.image_url, r.weight ?? null, r.current_qty],
      }))
    );
  }
}

export async function getInventoryProducts(): Promise<InventoryProductRow[]> {
  const db = getDb();
  const result = await db.execute(
    `SELECT sku, title, asin, upc, active, image_url, weight, current_qty, updated_at
     FROM inventory_products ORDER BY sku ASC`
  );
  return result.rows.map((r) => ({
    sku: r.sku as string,
    title: (r.title as string) ?? '',
    asin: (r.asin as string) ?? '',
    upc: (r.upc as string) ?? '',
    active: Number(r.active),
    image_url: (r.image_url as string) ?? '',
    weight: r.weight != null ? Number(r.weight) : null,
    current_qty: Number(r.current_qty),
    updated_at: (r.updated_at as string) ?? undefined,
  }));
}

export async function getInventoryProductMap(): Promise<Map<string, InventoryProductRow>> {
  const rows = await getInventoryProducts();
  const map = new Map<string, InventoryProductRow>();
  for (const r of rows) map.set(r.sku, r);
  return map;
}


// ---------------------------------------------------------------------------
// Product Catalog — combo_products
// ---------------------------------------------------------------------------

export interface ComboProductRow {
  sku: string;
  title: string;
  asin: string;
  upc: string;
  active: number;
  image_url: string;
}

export async function upsertComboProducts(rows: ComboProductRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO combo_products
                (sku, title, asin, upc, active, image_url, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(sku) DO UPDATE SET
                title      = excluded.title,
                asin       = excluded.asin,
                upc        = excluded.upc,
                active     = excluded.active,
                image_url  = excluded.image_url,
                updated_at = datetime('now')`,
        args: [r.sku, r.title, r.asin, r.upc, r.active, r.image_url],
      }))
    );
  }
}

export async function getComboProducts(): Promise<ComboProductRow[]> {
  const db = getDb();
  const result = await db.execute(
    `SELECT sku, title, asin, upc, active, image_url
     FROM combo_products ORDER BY sku ASC`
  );
  return result.rows.map((r) => ({
    sku: r.sku as string,
    title: (r.title as string) ?? '',
    asin: (r.asin as string) ?? '',
    upc: (r.upc as string) ?? '',
    active: Number(r.active),
    image_url: (r.image_url as string) ?? '',
  }));
}

export async function getComboProductSet(): Promise<Set<string>> {
  const rows = await getComboProducts();
  return new Set(rows.map((r) => r.sku));
}


// ---------------------------------------------------------------------------
// Combo Components (recipe table)
// ---------------------------------------------------------------------------

export interface ComboComponentRow {
  combo_sku: string;
  child_inventory_sku: string;
  quantity: number;
  sequence: number;
}

export async function upsertComboComponents(rows: ComboComponentRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO combo_components
                (combo_sku, child_inventory_sku, quantity, sequence)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(combo_sku, child_inventory_sku) DO UPDATE SET
                quantity = excluded.quantity,
                sequence = excluded.sequence`,
        args: [r.combo_sku, r.child_inventory_sku, r.quantity, r.sequence],
      }))
    );
  }
}

export async function getComboComponents(): Promise<ComboComponentRow[]> {
  const db = getDb();
  const result = await db.execute(
    `SELECT combo_sku, child_inventory_sku, quantity, sequence
     FROM combo_components ORDER BY combo_sku ASC, sequence ASC`
  );
  return result.rows.map((r) => ({
    combo_sku: r.combo_sku as string,
    child_inventory_sku: r.child_inventory_sku as string,
    quantity: Number(r.quantity),
    sequence: Number(r.sequence),
  }));
}

/**
 * Build in-memory combo lookup: combo_sku → ComboComponentRow[].
 * Used during order ingestion to explode combos into child allocations.
 */
export async function buildComboComponentLookup(): Promise<Map<string, ComboComponentRow[]>> {
  const rows = await getComboComponents();
  const map = new Map<string, ComboComponentRow[]>();
  for (const r of rows) {
    const list = map.get(r.combo_sku) ?? [];
    list.push(r);
    map.set(r.combo_sku, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Legacy combo_product_recipes — kept for backward compat
// ---------------------------------------------------------------------------

export interface ComboRecipeRow {
  parent_combo_sku: string;
  child_inventory_sku: string;
  quantity_multiplier: number;
}

export async function buildComboLookup(): Promise<Map<string, ComboRecipeRow[]>> {
  const components = await buildComboComponentLookup();
  const legacyMap = new Map<string, ComboRecipeRow[]>();
  for (const [comboSku, children] of components) {
    legacyMap.set(
      comboSku,
      children.map((c) => ({
        parent_combo_sku: c.combo_sku,
        child_inventory_sku: c.child_inventory_sku,
        quantity_multiplier: c.quantity,
      }))
    );
  }
  return legacyMap;
}


// ---------------------------------------------------------------------------
// SKU Mappings
// ---------------------------------------------------------------------------

export interface SkuMappingRow {
  source_sku: string;
  marketplace: string;
  teapplix_sku: string;
  mapping_type: string;
  active: number;
  confidence: number;
  notes: string;
}

export async function upsertSkuMappings(rows: SkuMappingRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO sku_mappings
                (source_sku, marketplace, teapplix_sku, mapping_type, active, confidence, notes, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(source_sku, marketplace) DO UPDATE SET
                teapplix_sku = excluded.teapplix_sku,
                mapping_type = excluded.mapping_type,
                active       = excluded.active,
                confidence   = excluded.confidence,
                notes        = excluded.notes,
                updated_at   = datetime('now')`,
        args: [r.source_sku, r.marketplace, r.teapplix_sku, r.mapping_type, r.active, r.confidence, r.notes ?? null],
      }))
    );
  }
}

export async function getSkuMappings(): Promise<SkuMappingRow[]> {
  const db = getDb();
  const result = await db.execute(
    `SELECT source_sku, marketplace, teapplix_sku, mapping_type, active, confidence, notes
     FROM sku_mappings WHERE active = 1 ORDER BY source_sku ASC`
  );
  return result.rows.map((r) => ({
    source_sku: r.source_sku as string,
    marketplace: r.marketplace as string,
    teapplix_sku: r.teapplix_sku as string,
    mapping_type: r.mapping_type as string,
    active: Number(r.active),
    confidence: Number(r.confidence),
    notes: (r.notes as string) ?? '',
  }));
}

/**
 * Build in-memory mapping lookup: normalized_source_sku → teapplix_sku.
 * Keys are lowercased + trimmed for case-insensitive matching.
 */
export async function buildMappingLookup(): Promise<Map<string, string>> {
  const rows = await getSkuMappings();
  const map = new Map<string, string>();
  for (const r of rows) {
    // Index by exact source_sku
    map.set(r.source_sku, r.teapplix_sku);
    // Also index by lowercased version for case-insensitive fallback
    const lower = r.source_sku.toLowerCase().trim();
    if (!map.has(lower)) map.set(lower, r.teapplix_sku);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Mapping Errors
// ---------------------------------------------------------------------------

export interface MappingErrorRow {
  error_type: string;
  source_sku?: string;
  teapplix_sku?: string;
  message: string;
  severity: string;
}

export async function insertMappingErrors(rows: MappingErrorRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO mapping_errors (error_type, source_sku, teapplix_sku, message, severity)
              VALUES (?, ?, ?, ?, ?)`,
        args: [r.error_type, r.source_sku ?? null, r.teapplix_sku ?? null, r.message, r.severity],
      }))
    );
  }
}

export async function getMappingErrors(): Promise<(MappingErrorRow & { id: number; created_at: string })[]> {
  const db = getDb();
  const result = await db.execute(
    `SELECT id, error_type, source_sku, teapplix_sku, message, severity, created_at
     FROM mapping_errors ORDER BY created_at DESC LIMIT 500`
  );
  return result.rows.map((r) => ({
    id: Number(r.id),
    error_type: r.error_type as string,
    source_sku: (r.source_sku as string) ?? undefined,
    teapplix_sku: (r.teapplix_sku as string) ?? undefined,
    message: r.message as string,
    severity: r.severity as string,
    created_at: r.created_at as string,
  }));
}


// ---------------------------------------------------------------------------
// Unmapped SKUs
// ---------------------------------------------------------------------------

export async function recordUnmappedSku(
  sku: string,
  date: string,
  marketplace?: string,
  qty?: number,
  revenue?: number
): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO unmapped_skus
            (raw_storefront_sku, marketplace, first_seen_at, last_seen_at, order_count, qty_sold, revenue)
          VALUES (?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(raw_storefront_sku) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            order_count  = order_count + 1,
            qty_sold     = qty_sold + excluded.qty_sold,
            revenue      = revenue + excluded.revenue`,
    args: [sku, marketplace ?? null, date, date, qty ?? 0, revenue ?? 0],
  });
}

/**
 * Mark one or more raw storefront SKUs as resolved in the unmapped_skus queue.
 * Called after a mapping is saved so the banner count drops immediately.
 */
export async function resolveUnmappedSkus(skus: string[]): Promise<void> {
  if (skus.length === 0) return;
  const db = getDb();
  const BATCH = 100;
  for (let i = 0; i < skus.length; i += BATCH) {
    const chunk = skus.slice(i, i + BATCH);
    const placeholders = chunk.map(() => '?').join(',');
    await db.execute({
      sql: `UPDATE unmapped_skus SET status = 'resolved' WHERE raw_storefront_sku IN (${placeholders})`,
      args: chunk,
    });
  }
}

export async function getUnmappedSkus(): Promise<{
  id: number;
  raw_storefront_sku: string;
  marketplace: string | null;
  first_seen_at: string;
  last_seen_at: string;
  order_count: number;
  qty_sold: number;
  revenue: number;
  status: string;
}[]> {
  const db = getDb();
  const result = await db.execute(
    `SELECT id, raw_storefront_sku, marketplace, first_seen_at, last_seen_at,
            order_count, qty_sold, revenue, status
     FROM unmapped_skus WHERE status = 'pending' ORDER BY last_seen_at DESC`
  );
  const pending = result.rows.map((r) => ({
    id: Number(r.id),
    raw_storefront_sku: r.raw_storefront_sku as string,
    marketplace: r.marketplace as string | null,
    first_seen_at: r.first_seen_at as string,
    last_seen_at: r.last_seen_at as string,
    order_count: Number(r.order_count),
    qty_sold: Number(r.qty_sold),
    revenue: Number(r.revenue),
    status: r.status as string,
  }));

  if (pending.length === 0) return [];

  // Check if any of these pending unmapped SKUs match inventory or combo products (case-insensitive)
  const [invMap, comboSet] = await Promise.all([
    getInventoryProductMap(),
    getComboProductSet(),
  ]);

  const lowerInventorySkus = new Set([...invMap.keys()].map((s) => s.toLowerCase().trim()));
  const lowerComboSkus = new Set([...comboSet].map((s) => s.toLowerCase().trim()));

  const autoResolvable: string[] = [];
  const remaining = pending.filter((item) => {
    const lower = item.raw_storefront_sku.toLowerCase().trim();
    if (lowerInventorySkus.has(lower) || lowerComboSkus.has(lower)) {
      autoResolvable.push(item.raw_storefront_sku);
      return false; // auto-resolved, exclude from active pending list
    }
    return true;
  });

  if (autoResolvable.length > 0) {
    resolveUnmappedSkus(autoResolvable).catch((err) => {
      console.error('[getUnmappedSkus] Failed to auto-resolve SKUs:', err);
    });
  }

  return remaining;
}


// ---------------------------------------------------------------------------
// Order Lines + Inventory Allocations — the core ingestion pipeline
// ---------------------------------------------------------------------------

export interface RawOrderItem {
  /** Raw SKU string from the storefront (item.Name). */
  marketplace_sku: string;
  order_id: string;
  order_date: string;
  marketplace?: string;
  qty: number;
  total_price: number;
  line_number: number;
}

export interface OrderLineRow {
  order_line_id: string;
  customer_order_id: string;
  order_date: string;
  marketplace: string;
  raw_storefront_sku: string;
  resolved_teapplix_sku: string | null;
  resolved_product_type: 'inventory' | 'combo' | 'unknown' | null;
  qty_sold: number;
  revenue: number;
  mapping_status: 'mapped' | 'unmapped' | 'mapping_error';
}

export interface AllocationRow {
  allocation_id: string;
  order_line_id: string;
  inventory_sku: string;
  qty_depleted: number;
  source_teapplix_sku: string;
  source_storefront_sku: string;
  allocation_type: 'direct' | 'combo_explode';
}

export interface IngestResult {
  orderLineRows: OrderLineRow[];
  allocationRows: AllocationRow[];
  unmappedSkus: string[];
  mappingErrors: string[];
  // Legacy compat
  orderRows: OrderRow[];
}

/**
 * Core ingestion pipeline — mirrors Teapplix's exact order flow:
 *
 * 1. Preserve raw storefront SKU exactly as received.
 * 2. Resolve via sku_mappings → Teapplix SKU.
 * 3. Determine product type: inventory | combo | unknown.
 * 4. Revenue stays on the sold SKU (combo or inventory). Never split.
 * 5. Inventory allocation:
 *    - inventory product → 1 allocation row to itself (direct)
 *    - combo product → N allocation rows to children (combo_explode)
 *    - unmapped → no allocation, log to unmapped_skus
 *    - mapping points to missing SKU → log to mapping_errors
 */

// ---------------------------------------------------------------------------
// Pack-size logic delegated entirely to lib/sku/resolver.ts (parsePack).
// No local WORD_PACK_SIZES or getSkuPackMultiplier here.
// ---------------------------------------------------------------------------

export function buildIngestRows(
  items: RawOrderItem[],
  mappingLookup: Map<string, string>,
  comboLookup: Map<string, ComboComponentRow[]>,
  inventorySkuSet: Set<string>,
  comboSkuSet: Set<string>
): IngestResult {
  const orderLineRows: OrderLineRow[] = [];
  const allocationRows: AllocationRow[] = [];
  const unmappedSkus: string[] = [];
  const mappingErrors: string[] = [];
  // Legacy compat
  const orderRows: OrderRow[] = [];

  // Phantom-line guard: Teapplix sends two lines per multi-pack/combo order —
  //   1. ASIN line  (e.g. B0FHT53VLL → AM5304-50) → resolves as combo
  //   2. Bare-SKU line (e.g. AM5304 → AM5304-1) → resolves as inventory
  // Both have the same order_id + qty_sold, but the bare-SKU line is a duplicate
  // of the physical units already covered by the combo_explode path.
  // Build a set of (order_id, qty) pairs that have a combo line — inventory lines
  // matching these will be allowed into order_lines (revenue) but skipped for allocations.
  const comboOrderKeys = new Set<string>();
  for (const item of items) {
    const rawSku = item.marketplace_sku;
    let tSku: string | null = null;
    if (mappingLookup.has(rawSku)) tSku = mappingLookup.get(rawSku)!;
    else {
      const norm = resolverNormalizeSku(rawSku).toLowerCase();
      if (mappingLookup.has(norm)) tSku = mappingLookup.get(norm)!;
    }
    if (tSku && comboSkuSet.has(tSku)) {
      comboOrderKeys.add(`${item.order_id}|${item.qty}`);
    }
  }

  for (const item of items) {
    const { marketplace_sku, order_id, order_date, marketplace, qty, total_price, line_number } = item;
    const orderLineId = `${order_id}|${line_number}`;
    const rawSku = marketplace_sku;

    // Step 1: raw storefront SKU → sku_mappings → teapplix SKU.
    // Normalize via resolver.normalizeSku for the fallback lowercase check.
    // No silent auto-map to catalog — if not in sku_mappings, it is unmapped.
    let teapplixSku: string | null = null;
    if (mappingLookup.has(rawSku)) {
      teapplixSku = mappingLookup.get(rawSku)!;
    } else {
      const normalized = resolverNormalizeSku(rawSku).toLowerCase();
      if (mappingLookup.has(normalized)) {
        teapplixSku = mappingLookup.get(normalized)!;
      }
    }

    // Step 2: Determine product type FIRST so we know whether parsePack applies.
    // parsePack (pack-size multiply) applies ONLY to inventory direct SKUs.
    // Combo SKUs must NOT be pack-multiplied — their unit count is already encoded
    // in combo_components.quantity. Applying parsePack to a combo SKU like
    // "AM5304-20" would multiply qty × 20, then combo explode would multiply again
    // by component.quantity (also 20), yielding 400× for a single-pack purchase.
    let productType: 'inventory' | 'combo' | 'unknown' | null = null;
    let mappingStatus: 'mapped' | 'unmapped' | 'mapping_error' = 'unmapped';

    if (teapplixSku === null) {
      // Not in sku_mappings → unmapped. Goes to unmapped_skus queue.
      unmappedSkus.push(rawSku);
      mappingStatus = 'unmapped';
    } else if (inventorySkuSet.has(teapplixSku)) {
      productType = 'inventory';
      mappingStatus = 'mapped';
    } else if (comboSkuSet.has(teapplixSku)) {
      productType = 'combo';
      mappingStatus = 'mapped';
    } else {
      // Mapping exists but target SKU missing from both product tables.
      mappingErrors.push(teapplixSku);
      mappingStatus = 'mapping_error';
      productType = 'unknown';
    }

    // Step 3: parsePack(teapplix SKU) → { base, qty }
    // Only apply pack multiplier for inventory direct SKUs (e.g. AM5233-2 → 2 base units).
    // Combo SKUs: use raw qty — combo_components.quantity handles the explosion.
    const { qty: packQty } = (teapplixSku && productType === 'inventory')
      ? parsePack(teapplixSku)
      : { qty: 1 };
    const effectiveQty = qty * packQty;

    // Step 4: Write order line (revenue on sold SKU, always).
    // order_lines stores the raw line as today.
    const orderLine: OrderLineRow = {
      order_line_id: orderLineId,
      customer_order_id: order_id,
      order_date,
      marketplace: marketplace ?? 'UNKNOWN',
      raw_storefront_sku: rawSku,
      resolved_teapplix_sku: teapplixSku,
      resolved_product_type: productType,
      qty_sold: effectiveQty,
      revenue: Math.round(total_price * 100) / 100,
      mapping_status: mappingStatus,
    };
    orderLineRows.push(orderLine);

    // Legacy compat row
    orderRows.push({
      order_id: orderLineId,
      order_date,
      sku: rawSku,
      resolved_sku: teapplixSku,
      qty: effectiveQty,
      unit_price: effectiveQty > 0 ? Math.round((total_price / effectiveQty) * 100) / 100 : 0,
      total_price: Math.round(total_price * 100) / 100,
      is_combo: productType === 'combo' ? 1 : 0,
    });

    // Step 5: Create inventory allocations (only for mapped, resolved lines).
    if (mappingStatus !== 'mapped' || productType === 'unknown') continue;

    if (productType === 'inventory') {
      // Phantom-line guard: skip allocation if a combo line exists for this order+qty.
      // The combo_explode path already covers the physical units — writing a direct
      // allocation here would double-count depletion for the same physical sale.
      if (comboOrderKeys.has(`${order_id}|${qty}`)) continue;

      // inventory → ONE allocation on resolveBaseUnit(base), units = effectiveQty, type 'direct'.
      const { base } = parsePack(teapplixSku!);
      const inventoryUnit = resolveBaseUnit(base, inventorySkuSet) ?? teapplixSku!;
      allocationRows.push({
        allocation_id: `${orderLineId}|${inventoryUnit}`,
        order_line_id: orderLineId,
        inventory_sku: inventoryUnit,
        qty_depleted: effectiveQty,
        source_teapplix_sku: teapplixSku!,
        source_storefront_sku: rawSku,
        allocation_type: 'direct',
      });
    } else if (productType === 'combo') {
      // combo → read combo_components, one allocation per child.
      // units = orderQty × child.qty, revenue split by stored allocation share, type 'combo_explode'.
      const components = comboLookup.get(teapplixSku!) ?? [];
      const totalChildQty = components.reduce((s, c) => s + c.quantity, 0);
      for (const component of components) {
        const allocationShare = totalChildQty > 0 ? component.quantity / totalChildQty : 0;
        allocationRows.push({
          allocation_id: `${orderLineId}|${component.child_inventory_sku}`,
          order_line_id: orderLineId,
          inventory_sku: component.child_inventory_sku,
          qty_depleted: qty * component.quantity,
          source_teapplix_sku: teapplixSku!,
          source_storefront_sku: rawSku,
          allocation_type: 'combo_explode',
        });
      }
    }
  }

  return {
    orderLineRows,
    allocationRows,
    unmappedSkus: [...new Set(unmappedSkus)],
    mappingErrors: [...new Set(mappingErrors)],
    orderRows,
  };
}


// ---------------------------------------------------------------------------
// Write — order_lines and inventory_allocations
// ---------------------------------------------------------------------------

export async function upsertOrderLines(rows: OrderLineRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
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
      }))
    );
  }
}

export async function upsertInventoryAllocations(rows: AllocationRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();

  // Delete stale allocations for these order lines first (idempotent re-sync)
  const orderLineIds = [...new Set(rows.map((r) => r.order_line_id))];
  const DEL_BATCH = 100;
  for (let i = 0; i < orderLineIds.length; i += DEL_BATCH) {
    const chunk = orderLineIds.slice(i, i + DEL_BATCH);
    const placeholders = chunk.map(() => '?').join(',');
    await db.execute({
      sql: `DELETE FROM inventory_allocations WHERE order_line_id IN (${placeholders})`,
      args: chunk,
    });
  }

  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT OR REPLACE INTO inventory_allocations
                (allocation_id, order_line_id, inventory_sku, qty_depleted,
                 source_teapplix_sku, source_storefront_sku, allocation_type)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          r.allocation_id, r.order_line_id, r.inventory_sku, r.qty_depleted,
          r.source_teapplix_sku, r.source_storefront_sku, r.allocation_type,
        ],
      }))
    );
  }
}

// ---------------------------------------------------------------------------
// Legacy write functions — kept for backward compat with existing sync routes
// ---------------------------------------------------------------------------

export interface OrderRow {
  order_id: string;
  order_date: string;
  sku: string;
  resolved_sku: string | null;
  qty: number;
  unit_price: number;
  total_price: number;
  is_combo?: number;
}

export async function upsertOrders(rows: OrderRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT OR REPLACE INTO orders
                (order_id, order_date, sku, resolved_sku, qty, unit_price, total_price, is_combo)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [r.order_id, r.order_date, r.sku, r.resolved_sku ?? null, r.qty, r.unit_price, r.total_price, r.is_combo ?? 0],
      }))
    );
  }
}

export async function upsertAllocations(rows: {
  order_id: string;
  order_date: string;
  physical_sku: string;
  qty_depleted: number;
  source_marketplace_sku: string;
  unit_cost_cogs: number | null;
}[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  const orderIds = [...new Set(rows.map((r) => r.order_id))];
  const DEL_BATCH = 100;
  for (let i = 0; i < orderIds.length; i += DEL_BATCH) {
    const chunk = orderIds.slice(i, i + DEL_BATCH);
    const placeholders = chunk.map(() => '?').join(',');
    await db.execute({
      sql: `DELETE FROM order_item_allocations WHERE order_id IN (${placeholders})`,
      args: chunk,
    });
  }
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO order_item_allocations
                (order_id, order_date, physical_sku, qty_depleted, source_marketplace_sku, unit_cost_cogs)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [r.order_id, r.order_date, r.physical_sku, r.qty_depleted, r.source_marketplace_sku, r.unit_cost_cogs ?? null],
      }))
    );
  }
}


// ---------------------------------------------------------------------------
// Inventory (current qty on inventory_products)
// ---------------------------------------------------------------------------

export interface InventoryRow {
  sku: string;
  item_title: string;
  asin: string;
  upc: string;
  qty_on_hand: number;
  qty_to_ship: number;
  qty_available: number;
  last_synced: string;
  unit_cost?: number;
}

/** Update current_qty on inventory_products from a live Teapplix sync. */
export async function upsertInventory(rows: InventoryRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO inventory_products
                (sku, title, asin, upc, active, current_qty, cost_of_goods_sold, updated_at)
              VALUES (?, ?, ?, ?, 1, ?, ?, datetime('now'))
              ON CONFLICT(sku) DO UPDATE SET
                title                = COALESCE(excluded.title, title),
                asin                 = COALESCE(excluded.asin, asin),
                upc                  = COALESCE(excluded.upc, upc),
                current_qty          = excluded.current_qty,
                cost_of_goods_sold   = CASE
                                         WHEN excluded.cost_of_goods_sold > 0
                                         THEN excluded.cost_of_goods_sold
                                         ELSE cost_of_goods_sold
                                       END,
                updated_at           = datetime('now')`,
        args: [normalizeSku(r.sku), r.item_title ?? '', r.asin ?? '', r.upc ?? '', r.qty_available, r.unit_cost ?? 0],
      }))
    );
  }
}

export async function upsertInventorySnapshot(rows: InventoryRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  const today = getTodayInTz();
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT OR REPLACE INTO inventory_snapshots (sku, snapshot_date, qty_available)
              VALUES (?, ?, ?)`,
        args: [normalizeSku(r.sku), today, r.qty_available],
      }))
    );
  }
}

export async function getInventory(): Promise<InventoryRow[]> {
  const db = getDb();
  const result = await db.execute(
    `SELECT sku, title AS item_title, asin, upc,
            current_qty AS qty_on_hand, 0 AS qty_to_ship, current_qty AS qty_available,
            updated_at AS last_synced
     FROM inventory_products ORDER BY sku ASC`
  );
  return result.rows.map((r) => ({
    sku: r.sku as string,
    item_title: (r.item_title as string) ?? '',
    asin: (r.asin as string) ?? '',
    upc: (r.upc as string) ?? '',
    qty_on_hand: Number(r.qty_on_hand),
    qty_to_ship: Number(r.qty_to_ship),
    qty_available: Number(r.qty_available),
    last_synced: (r.last_synced as string) ?? '',
  }));
}

export async function getMissingSkus(skus: string[]): Promise<string[]> {
  if (skus.length === 0) return [];
  const db = getDb();
  const placeholders = skus.map(() => '?').join(',');
  const result = await db.execute({
    sql: `SELECT sku FROM inventory_products WHERE sku IN (${placeholders})`,
    args: skus,
  });
  const found = new Set(result.rows.map((r) => r.sku as string));
  return skus.filter((s) => !found.has(s));
}

export async function getInventoryMap(): Promise<Map<string, number>> {
  const db = getDb();
  // Only base-unit SKUs (same filter as restock planner) — excludes pack variants
  // like 5237-2, 5237-5, 5237-10 which would inflate the family stock sum.
  // Keep: 5237-1, AM5237-1, 5237, NS5340, 5233B-1
  // Drop: 5237-2, 5237-5, 5237-10, AM5237-20, etc.
  const result = await db.execute(`
    SELECT sku, current_qty FROM inventory_products
    WHERE active = 1
      AND sku NOT GLOB '*-[2-9]'
      AND sku NOT GLOB '*-[0-9][0-9]'
      AND sku NOT GLOB '*-[0-9][0-9][0-9]'
  `);
  const map = new Map<string, number>();
  for (const r of result.rows) {
    map.set(r.sku as string, Number(r.current_qty));
  }
  return map;
}

export async function getCostMap(): Promise<Map<string, number>> {
  const db = getDb();
  const result = await db.execute(`SELECT sku, unit_cost FROM inventory_products`);
  const map = new Map<string, number>();
  for (const r of result.rows) {
    map.set(r.sku as string, Number(r.unit_cost ?? 0.0));
  }
  return map;
}


// ---------------------------------------------------------------------------
// Read — Sales / Revenue Reports (use order_lines, not allocations)
// ---------------------------------------------------------------------------

interface DayAggRow {
  order_date: string;
  order_count: number;
  total_revenue: number;
}

interface SkuAggRow {
  order_date: string;
  sku: string;
  qty: number;
  total_price: number;
  unit_price: number;
}

function buildSummaries(dayRows: DayAggRow[], skuRows: SkuAggRow[], cogsMap: Map<string, number> = new Map()): DailySummary[] {
  const skusByDate = new Map<string, SkuRecord[]>();
  for (const r of skuRows) {
    const list = skusByDate.get(r.order_date) ?? [];
    list.push({
      sku: r.sku,
      quantitySold: r.qty,
      totalRevenue: Math.round(r.total_price * 100) / 100,
      unitPrice: Math.round(r.unit_price * 100) / 100,
    });
    skusByDate.set(r.order_date, list);
  }
  return dayRows.map((d) => {
    const skus = skusByDate.get(d.order_date) ?? [];
    const aov = d.order_count > 0 ? d.total_revenue / d.order_count : 0;
    const cogs = cogsMap.get(d.order_date) ?? 0;
    return {
      date: d.order_date,
      orderCount: d.order_count,
      totalRevenue: Math.round(d.total_revenue * 100) / 100,
      aov: Math.round(aov * 100) / 100,
      cogs: Math.round(cogs * 100) / 100,
      skus,
    };
  });
}

/** Revenue report: uses order_lines (sold SKU, not depleted inventory SKU).
 *  Always returns an entry for every calendar day in the window — days with
 *  no synced orders get a zero-revenue placeholder so the table always shows
 *  at least the last `days` rows. */
export async function getRecentSummaries(days: number): Promise<DailySummary[]> {
  const db = getDb();
  const startStr = getDateNDaysAgoInTz(days - 1);
  const endStr   = getTodayInTz();

  const [dayResult, skuResult, cogsResult] = await Promise.all([
    db.execute({
      sql: `SELECT order_date,
                   COUNT(DISTINCT customer_order_id) AS order_count,
                   SUM(CASE WHEN mapping_status != 'unmapped' THEN revenue ELSE 0 END) AS total_revenue
            FROM order_lines
            WHERE order_date >= ? AND order_date <= ?
            GROUP BY order_date ORDER BY order_date ASC`,
      args: [startStr, endStr],
    }),
    db.execute({
      sql: `SELECT order_date,
                   COALESCE(resolved_teapplix_sku, raw_storefront_sku) AS sku,
                   SUM(qty_sold) AS qty,
                   SUM(revenue) AS total_price,
                   SUM(revenue) / NULLIF(SUM(qty_sold), 0) AS unit_price
            FROM order_lines
            WHERE order_date >= ? AND order_date <= ? AND mapping_status != 'unmapped'
            GROUP BY order_date, sku ORDER BY order_date ASC, qty DESC`,
      args: [startStr, endStr],
    }),
    db.execute({
      sql: `SELECT ol.order_date,
                   SUM(ia.qty_depleted * ip.unit_cost) AS total_cogs
            FROM inventory_allocations ia
            JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
            JOIN inventory_products ip ON ip.sku = ia.inventory_sku
            WHERE ol.order_date >= ? AND ol.order_date <= ?
            GROUP BY ol.order_date`,
      args: [startStr, endStr],
    }),
  ]);

  const dayRows = dayResult.rows.map((r) => ({
    order_date: r.order_date as string,
    order_count: Number(r.order_count),
    total_revenue: Number(r.total_revenue),
  }));
  const skuRows = skuResult.rows.map((r) => ({
    order_date: r.order_date as string,
    sku: r.sku as string,
    qty: Number(r.qty),
    total_price: Number(r.total_price),
    unit_price: Number(r.unit_price),
  }));
  const cogsMap = new Map<string, number>();
  for (const r of cogsResult.rows) {
    cogsMap.set(r.order_date as string, Number(r.total_cogs));
  }

  const summaries = buildSummaries(dayRows, skuRows, cogsMap);

  // Zero-fill: ensure every day in the window has an entry so the table
  // always shows the full requested range even when no orders were synced.
  const summaryByDate = new Map(summaries.map((s) => [s.date, s]));
  const filled: DailySummary[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dateStr = getDateNDaysAgoInTz(i);
    filled.push(
      summaryByDate.get(dateStr) ?? {
        date: dateStr,
        orderCount: 0,
        totalRevenue: 0,
        aov: 0,
        cogs: 0,
        skus: [],
      }
    );
  }
  return filled;
}

export async function getSummariesForYear(year: number): Promise<DailySummary[]> {
  const db = getDb();
  const startStr = `${year}-01-01`;
  const endStr = `${year}-12-31`;

  const [dayResult, skuResult, cogsResult] = await Promise.all([
    db.execute({
      sql: `SELECT order_date,
                   COUNT(DISTINCT customer_order_id) AS order_count,
                   SUM(CASE WHEN mapping_status != 'unmapped' THEN revenue ELSE 0 END) AS total_revenue
            FROM order_lines
            WHERE order_date >= ? AND order_date <= ?
            GROUP BY order_date ORDER BY order_date ASC`,
      args: [startStr, endStr],
    }),
    db.execute({
      sql: `SELECT order_date,
                   COALESCE(resolved_teapplix_sku, raw_storefront_sku) AS sku,
                   SUM(qty_sold) AS qty,
                   SUM(revenue) AS total_price,
                   SUM(revenue) / NULLIF(SUM(qty_sold), 0) AS unit_price
            FROM order_lines
            WHERE order_date >= ? AND order_date <= ? AND mapping_status != 'unmapped'
            GROUP BY order_date, sku ORDER BY order_date ASC, qty DESC`,
      args: [startStr, endStr],
    }),
    db.execute({
      sql: `SELECT ol.order_date,
                   SUM(ia.qty_depleted * ip.unit_cost) AS total_cogs
            FROM inventory_allocations ia
            JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
            JOIN inventory_products ip ON ip.sku = ia.inventory_sku
            WHERE ol.order_date >= ? AND ol.order_date <= ?
            GROUP BY ol.order_date`,
      args: [startStr, endStr],
    }),
  ]);

  const dayRows = dayResult.rows.map((r) => ({
    order_date: r.order_date as string,
    order_count: Number(r.order_count),
    total_revenue: Number(r.total_revenue),
  }));
  const skuRows = skuResult.rows.map((r) => ({
    order_date: r.order_date as string,
    sku: r.sku as string,
    qty: Number(r.qty),
    total_price: Number(r.total_price),
    unit_price: Number(r.unit_price),
  }));
  const cogsMap = new Map<string, number>();
  for (const r of cogsResult.rows) {
    cogsMap.set(r.order_date as string, Number(r.total_cogs));
  }

  return buildSummaries(dayRows, skuRows, cogsMap);
}

export async function getTodaySummary(): Promise<DailySummary | null> {
  const db = getDb();
  const today = getTodayInTz();

  const [dayResult, skuResult, cogsResult] = await Promise.all([
    db.execute({
      sql: `SELECT order_date,
                   COUNT(DISTINCT customer_order_id) AS order_count,
                   SUM(CASE WHEN mapping_status != 'unmapped' THEN revenue ELSE 0 END) AS total_revenue
            FROM order_lines WHERE order_date = ?
            GROUP BY order_date`,
      args: [today],
    }),
    db.execute({
      sql: `SELECT order_date,
                   COALESCE(resolved_teapplix_sku, raw_storefront_sku) AS sku,
                   SUM(qty_sold) AS qty,
                   SUM(revenue) AS total_price,
                   SUM(revenue) / NULLIF(SUM(qty_sold), 0) AS unit_price
            FROM order_lines WHERE order_date = ? AND mapping_status != 'unmapped'
            GROUP BY sku ORDER BY qty DESC`,
      args: [today],
    }),
    db.execute({
      sql: `SELECT ol.order_date,
                   SUM(ia.qty_depleted * ip.unit_cost) AS total_cogs
            FROM inventory_allocations ia
            JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
            JOIN inventory_products ip ON ip.sku = ia.inventory_sku
            WHERE ol.order_date = ?
            GROUP BY ol.order_date`,
      args: [today],
    }),
  ]);

  if (dayResult.rows.length === 0) return null;

  const dayRows = dayResult.rows.map((r) => ({
    order_date: r.order_date as string,
    order_count: Number(r.order_count),
    total_revenue: Number(r.total_revenue),
  }));
  const skuRows = skuResult.rows.map((r) => ({
    order_date: r.order_date as string,
    sku: r.sku as string,
    qty: Number(r.qty),
    total_price: Number(r.total_price),
    unit_price: Number(r.unit_price),
  }));
  const cogsMap = new Map<string, number>();
  if (cogsResult.rows.length > 0) {
    cogsMap.set(cogsResult.rows[0].order_date as string, Number(cogsResult.rows[0].total_cogs));
  }

  return buildSummaries(dayRows, skuRows, cogsMap)[0] ?? null;
}


// ---------------------------------------------------------------------------
// Inventory Depletion Report
// Uses inventory_allocations (physical depletion), NOT order_lines.
// Restock forecasting must use this, not sales rows.
// ---------------------------------------------------------------------------

export interface DepletionRow {
  inventory_sku: string;
  title: string;
  qty_depleted: number;
  order_count: number;
  direct_sales: number;
  combo_sales: number;
}

export async function getDepletionReport(days: number): Promise<DepletionRow[]> {
  const db = getDb();
  const startStr = getDateNDaysAgoInTz(days - 1);

  const result = await db.execute({
    sql: `SELECT
            ia.inventory_sku,
            COALESCE(ip.title, ia.inventory_sku) AS title,
            SUM(ia.qty_depleted) AS qty_depleted,
            COUNT(DISTINCT ia.order_line_id) AS order_count,
            SUM(CASE WHEN ia.allocation_type = 'direct' THEN ia.qty_depleted ELSE 0 END) AS direct_sales,
            SUM(CASE WHEN ia.allocation_type = 'combo_explode' THEN ia.qty_depleted ELSE 0 END) AS combo_sales
          FROM inventory_allocations ia
          JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
          LEFT JOIN inventory_products ip ON ip.sku = ia.inventory_sku
          WHERE ol.order_date >= ?
          GROUP BY ia.inventory_sku
          ORDER BY qty_depleted DESC`,
    args: [startStr],
  });

  return result.rows.map((r) => ({
    inventory_sku: r.inventory_sku as string,
    title: (r.title as string) ?? '',
    qty_depleted: Number(r.qty_depleted),
    order_count: Number(r.order_count),
    direct_sales: Number(r.direct_sales),
    combo_sales: Number(r.combo_sales),
  }));
}

// ---------------------------------------------------------------------------
// Restock Planner — uses inventory depletion velocity, not sales velocity
// ---------------------------------------------------------------------------

export interface StorefrontMapping {
  storefront_sku: string;
  mapped_sku: string;
  combo_qty: number | null;
}

// ---------------------------------------------------------------------------
// Unified RestockRow — single table output for the new planner
// ---------------------------------------------------------------------------
export interface LyMonthlyUnits {
  month: string;  // e.g. "Jun 2025"
  year: number;
  monthNum: number;  // 1-12
  units: number;
}

export interface RestockRow {
  sku: string;
  item_title: string;
  qty_available: number;           // on-hand
  on_order: number;                // open PO qty (0 until PO table exists)
  /** Velocity in units/day, OOS-corrected */
  velocity_90d: number;
  velocity_adj: boolean;           // true if OOS correction applied
  velocity_in_stock_days: number;  // in-stock days used for velocity calc
  lead_time_days: number;
  days_of_cover: number | null;    // (onHand + onOrder) / velocity
  forecast: number;                // blended vel+seasonal forecast over horizon
  vel_forecast: number;            // velocity component
  seas_forecast: number;           // seasonal component (0 if no LY data)
  growth_multiplier: number;
  has_ly_data: boolean;
  safety_stock: number;
  order_now: number;               // max(0, ceil(target - onHand - onOrder))
  order_moq: number;               // same as order_now (no MOQ source)
  status: 'OVERSTOCKED' | 'DECLINING' | 'REORDER NOW' | 'OK';
  // debug / trust columns — surface in UI for traceability
  ly_daily_rate: number;           // LY implied daily rate (ly90Base / 90)
  is_declining: boolean;           // current run rate < 25% of LY daily rate
  status_driver: string;           // which rule fired (for tooltip)
  ly_horiz_base: number;           // LY horizon depleted (OOS-corrected base units) — used by family merge
  raw_depleted_90d: number;        // raw sum of qty_depleted in cur90 window — used by family merge to avoid reconstructing from capped velocity
  // LY monthly breakdown — 3 months (same calendar months, last year)
  ly_monthly_units: LyMonthlyUnits[];
  // Trailing 30-day units sold (base units, from inventory_allocations)
  units_30d: number;
  // legacy fields kept for UI compat
  cur_oos_days: number;
  ly_oos_days_90: number;
  projected_5m_need: number;       // alias → forecast
  recommended_order: number;       // alias → order_moq
  storefront_mappings?: StorefrontMapping[];
  // confidence / trust flags — surface in UI; do NOT change underlying math
  confidence_flags: string[];      // e.g. ['velocity_only_no_ly', 'immature_snapshots', 'default_lead_time']
}

export async function getPhysicalSkuMappingsMap(): Promise<Map<string, StorefrontMapping[]>> {
  const db = getDb();
  // 1. Static mappings from sku_mappings & combo components
  const staticResult = await db.execute(`
    SELECT DISTINCT
      ip.sku AS physical_sku,
      sm.source_sku AS storefront_sku,
      sm.teapplix_sku AS mapped_sku,
      cc.quantity AS combo_qty
    FROM inventory_products ip
    JOIN sku_mappings sm ON sm.teapplix_sku = ip.sku OR sm.teapplix_sku IN (
      SELECT combo_sku FROM combo_components WHERE child_inventory_sku = ip.sku
    )
    LEFT JOIN combo_components cc ON cc.combo_sku = sm.teapplix_sku AND cc.child_inventory_sku = ip.sku
    WHERE ip.active = 1
      AND ip.sku NOT IN (SELECT DISTINCT combo_sku FROM combo_components)
      AND ip.sku NOT IN (SELECT DISTINCT sku FROM combo_products)
  `);

  // 2. Dynamic mappings from allocations
  const allocResult = await db.execute(`
    SELECT DISTINCT
      ia.inventory_sku AS physical_sku,
      ia.source_storefront_sku AS storefront_sku,
      ia.source_teapplix_sku AS mapped_sku,
      cc.quantity AS combo_qty
    FROM inventory_allocations ia
    LEFT JOIN combo_components cc ON cc.combo_sku = ia.source_teapplix_sku AND cc.child_inventory_sku = ia.inventory_sku
  `);

  const map = new Map<string, StorefrontMapping[]>();

  const addMapping = (physSku: string, item: StorefrontMapping) => {
    const list = map.get(physSku) ?? [];
    const exists = list.some(
      (x) => x.storefront_sku === item.storefront_sku && x.mapped_sku === item.mapped_sku
    );
    if (!exists) {
      list.push(item);
      map.set(physSku, list);
    }
  };

  for (const r of staticResult.rows) {
    const physSku = r.physical_sku as string;
    addMapping(physSku, {
      storefront_sku: r.storefront_sku as string,
      mapped_sku: r.mapped_sku as string,
      combo_qty: r.combo_qty != null ? Number(r.combo_qty) : null,
    });
  }

  for (const r of allocResult.rows) {
    const physSku = r.physical_sku as string;
    addMapping(physSku, {
      storefront_sku: r.storefront_sku as string,
      mapped_sku: r.mapped_sku as string,
      combo_qty: r.combo_qty != null ? Number(r.combo_qty) : null,
    });
  }

  return map;
}

// ---------------------------------------------------------------------------
// Unified Restock Planner — constants (tune before running)
// ---------------------------------------------------------------------------
const MIN_GROWTH_FLOOR    = 0.60;
const MAX_GROWTH_CAP      = 1.15;
const VELOCITY_CEILING    = 1.25;   // kept for reference — actual cap now 2.0× in velocity calc (allows up to ~45 OOS days)
const OOS_RECON_CAP       = 1.15;   // cap LY OOS reconstruction to 115% of raw depletion
const MIN_OOS_DAYS        = 15;     // min active days required to trust OOS reconstruction
const COVERAGE_DAYS       = 90;     // target stock cover after arrival (days)
const SEASONAL_WEIGHT     = 0.5;    // blend weight for seasonal forecast (0 = all velocity, 1 = all seasonal)
// Lead time by origin — FILL in sea-freight reality before running
const LEAD_TIME_DAYS: Record<string, number> = {
  thailand: 75,   // ← fill: Thailand sea freight (often 60–90d)
  china:    60,   // ← fill: China sea freight (often 45–75d)
  default:  60,   // ← fill: fallback for SKUs without known origin
};

export async function getRestockPlan(): Promise<RestockRow[]> {
  const now = Date.now();
  if (restockPlanCache && (now - restockPlanCache.timestamp < CACHE_TTL)) {
    return restockPlanCache.data;
  }

  const db = getDb();

  // ── Date boundaries (all TZ-corrected to America/Los_Angeles) ─────────────
  const today       = getTodayInTz();
  const cur90Start  = getDateNDaysAgoInTz(90);   // cur90 window start
  const cur30Start  = getDateNDaysAgoInTz(30);   // trailing 30d window start
  const ly90Start   = getDateNDaysAgoInTz(455);  // same 90-day window LY start (90+365)
  const ly90End     = getDateNDaysAgoInTz(365);  // LY window end

  // Horizon LY window: the calendar dates equal to [today .. today+horizon] shifted back 365 days.
  // We use the default lead time for boundary calc (individual rows will vary if origin known).
  const defaultLeadTime = LEAD_TIME_DAYS['default'];
  const horizonDays     = defaultLeadTime + COVERAGE_DAYS;
  const lyHorizonStart  = getDateNDaysAgoInTz(365);           // today-365
  const lyHorizonEnd    = getDateNDaysAgoInTz(365 - horizonDays); // today-365+horizon

  // LY monthly breakdown: same 3 calendar months last year
  // Today is June 3, 2026 → LY months = June 2025, May 2025, April 2025
  // Parse today string directly to avoid new Date("YYYY-MM-DD") UTC-midnight parse bug
  // (which rolls to previous day in western timezones).
  const lyMonthBoundaries: Array<{ label: string; year: number; month: number; start: string; end: string }> = (() => {
    const [todayYear, todayMonth] = today.split('-').map(Number); // month is 1-indexed
    const months = [];
    for (let offset = 0; offset < 3; offset++) {
      // Subtract 1 year and `offset` months from today
      let y = todayYear - 1;
      let m = todayMonth - offset;
      if (m <= 0) { m += 12; y -= 1; }
      const start = `${y}-${String(m).padStart(2, '0')}-01`;
      const lastDay = new Date(y, m, 0).getDate(); // m is 1-indexed; new Date(y, m, 0) = last day of month m
      const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      const label = new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
      months.push({ label, year: y, month: m, start, end });
    }
    return months;
  })();

  // ── Parallel DB queries ────────────────────────────────────────────────────
  const [
    cur90Result,
    ly90Result,
    lyHorizonResult,
    snapCur90Result,
    snapLy90Result,
    invResult,
    cur30Result,
    ...lyMonthResults
  ] = await Promise.all([
    // Current 90-day base units sold per physical inventory SKU.
    // Sourced from inventory_allocations: qty_depleted is already in base units
    // (pack × order qty was applied during ingest in buildIngestRows).
    // No UNION needed — allocations cover both direct and combo-explode paths.
    db.execute({
      sql: `SELECT ia.inventory_sku,
                   SUM(ia.qty_depleted)              AS depleted,
                   COUNT(DISTINCT ol.order_date)     AS in_stock_days,
                   COUNT(DISTINCT ia.order_line_id)  AS order_count,
                   ROUND(AVG(ia.qty_depleted), 2)    AS avg_order_size
            FROM inventory_allocations ia
            JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
            WHERE ol.order_date >= ?
            GROUP BY ia.inventory_sku`,
      args: [cur90Start],
    }),
    // LY same-90-day base units sold per physical SKU
    db.execute({
      sql: `SELECT ia.inventory_sku,
                   SUM(ia.qty_depleted)              AS depleted,
                   COUNT(DISTINCT ol.order_date)     AS in_stock_days
            FROM inventory_allocations ia
            JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
            WHERE ol.order_date >= ? AND ol.order_date <= ?
            GROUP BY ia.inventory_sku`,
      args: [ly90Start, ly90End],
    }),
    // LY horizon window base units sold per physical SKU (seasonality signal)
    db.execute({
      sql: `SELECT ia.inventory_sku,
                   SUM(ia.qty_depleted)              AS depleted,
                   COUNT(DISTINCT ol.order_date)     AS in_stock_days
            FROM inventory_allocations ia
            JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
            WHERE ol.order_date >= ? AND ol.order_date <= ?
            GROUP BY ia.inventory_sku`,
      args: [lyHorizonStart, lyHorizonEnd],
    }),
    // Snapshot in-stock days — current 90 window
    db.execute({
      sql: `SELECT sku, COUNT(*) AS snap_in_stock_days
            FROM inventory_snapshots
            WHERE snapshot_date >= ? AND qty_available > 0
            GROUP BY sku`,
      args: [cur90Start],
    }),
    // Snapshot in-stock days — LY 90 window
    db.execute({
      sql: `SELECT sku, COUNT(*) AS snap_in_stock_days
            FROM inventory_snapshots
            WHERE snapshot_date >= ? AND snapshot_date <= ? AND qty_available > 0
            GROUP BY sku`,
      args: [ly90Start, ly90End],
    }),
    // Physical inventory products — base unit SKUs only.
    // Exclude pack variants (SKUs ending in -2, -5, -10, etc.) since those represent
    // the same physical item in a different pack size. Only the -1 (single unit) rows
    // carry the authoritative qty_available from Teapplix.
    // Use GLOB to filter out trailing -<digit≥2> suffixes.
    // Keep: 5233-1, AM5233-1, 5233, AM5233, NS5340, 5233B-1
    // Drop: 5233-2, 5233-5, 5233-10, AM5234-2, AM5233-10, etc.
    db.execute(`
      SELECT sku, title, current_qty, lead_time_days, supplier_origin, moq, case_pack_qty
      FROM inventory_products
      WHERE active = 1
        AND sku NOT IN (SELECT DISTINCT combo_sku FROM combo_components)
        AND sku NOT IN (SELECT DISTINCT sku FROM combo_products)
        AND sku NOT GLOB '*-[2-9]'
        AND sku NOT GLOB '*-[0-9][0-9]'
        AND sku NOT GLOB '*-[0-9][0-9][0-9]'
    `),
    // LY monthly queries — one per month (dynamic, 3 months)
    // inventory_allocations.qty_depleted already in base units.
    // Trailing 30d units sold per inventory SKU (upper-bounded to today to exclude future-dated rows)
    db.execute({
      sql: `SELECT ia.inventory_sku, SUM(ia.qty_depleted) AS units
            FROM inventory_allocations ia
            JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
            WHERE ol.order_date >= ? AND ol.order_date <= ?
            GROUP BY ia.inventory_sku`,
      args: [cur30Start, today],
    }),
    ...lyMonthBoundaries.map(({ start, end }) =>
      db.execute({
        sql: `SELECT ia.inventory_sku, SUM(ia.qty_depleted) AS units
              FROM inventory_allocations ia
              JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
              WHERE ol.order_date >= ? AND ol.order_date <= ?
              GROUP BY ia.inventory_sku`,
        args: [start, end],
      })
    ),
  ]);

  // Fix 1: open PO qty per SKU — replaces hardcoded on_order = 0.
  // Graceful fallback: if open_purchase_orders table doesn't exist yet (migration
  // not yet run in this environment), returns empty map so behaviour is unchanged.
  const openPoResult = await db.execute(`
    SELECT sku, SUM(qty_ordered) AS qty_on_order
    FROM open_purchase_orders
    WHERE status = 'open'
    GROUP BY sku
  `).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  const openPoMap = new Map<string, number>();
  for (const r of openPoResult.rows) {
    openPoMap.set(r.sku as string, Number(r.qty_on_order));
  }

  // ── Build LY monthly lookup maps ──────────────────────────────────────────
  // lyMonthResults[i] corresponds to lyMonthBoundaries[i]
  // Index by both raw inventory_sku AND resolverNormalizeSku(sku) so AM-prefixed
  // allocation keys (e.g. "AM5304-1") match non-AM inventory_products rows ("5304-1").
  //
  // IMPORTANT: the norm key is a FALLBACK alias only — do NOT accumulate units onto
  // it when the norm key already has its own DB row (e.g. "5304-1" exists alongside
  // "AM5304-1"). Accumulating would double-count units for any SKU whose AM-variant
  // and non-AM variant both appear in inventory_allocations.
  const lyMonthMaps = lyMonthResults.map((result) => {
    const m = new Map<string, number>();
    for (const r of result.rows) {
      const allocSku = r.inventory_sku as string;
      const units = Number(r.units);
      m.set(allocSku, (m.get(allocSku) ?? 0) + units);
    }
    // Second pass: add normalized alias only when the norm key has no direct DB row.
    for (const [allocSku, units] of m) {
      const norm = resolverNormalizeSku(allocSku);
      if (norm !== allocSku && !m.has(norm)) {
        m.set(norm, units);
      }
    }
    return m;
  });

  // ── Build 30d lookup map ───────────────────────────────────────────────────
  // Same normalization: index raw + resolverNormalizeSku fallback.
  // IMPORTANT: norm key is a FALLBACK alias — only set when the norm key has no
  // direct DB row, to prevent double-counting when both "AM5304-1" and "5304-1"
  // appear as separate inventory_sku rows in inventory_allocations.
  const cur30Map = new Map<string, number>();
  for (const r of cur30Result.rows) {
    const allocSku = r.inventory_sku as string;
    const units = Number(r.units);
    cur30Map.set(allocSku, (cur30Map.get(allocSku) ?? 0) + units);
  }
  // Second pass: add normalized alias only when the norm key has no direct DB row.
  for (const [allocSku, units] of cur30Map) {
    const norm = resolverNormalizeSku(allocSku);
    if (norm !== allocSku && !cur30Map.has(norm)) {
      cur30Map.set(norm, units);
    }
  }



  // ── Build lookup maps ──────────────────────────────────────────────────────
  type AggRow = { depleted: number; in_stock_days: number; order_count: number; avg_order_size: number };
  const mkAggMap = (rows: typeof cur90Result.rows, skuCol = 'inventory_sku'): Map<string, AggRow> => {
    const m = new Map<string, AggRow>();
    for (const r of rows) m.set(r[skuCol] as string, {
      depleted: Number(r.depleted),
      in_stock_days: Number(r.in_stock_days),
      order_count: r.order_count != null ? Number(r.order_count) : 0,
      avg_order_size: r.avg_order_size != null ? Number(r.avg_order_size) : 0,
    });
    return m;
  };
  const mkSnapMap = (rows: typeof snapCur90Result.rows): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.sku as string, Number(r.snap_in_stock_days));
    return m;
  };

  const cur90Map     = mkAggMap(cur90Result.rows);
  const ly90Map      = mkAggMap(ly90Result.rows);
  const lyHorizMap   = mkAggMap(lyHorizonResult.rows);
  const snapCur90Map = mkSnapMap(snapCur90Result.rows);
  const snapLy90Map  = mkSnapMap(snapLy90Result.rows);

  const allInvSkus = invResult.rows.map((r) => r.sku as string);
  const allInvSkuSet = new Set(allInvSkus);

  // ── Pack-variant rollup ────────────────────────────────────────────────────
  // During ingest, when resolveBaseUnit fails (base not in inventorySkuSet),
  // the allocation falls back to storing the raw teapplixSku (e.g. "AM5252-4").
  // Pack variants ending in -2, -5, -10, etc. are filtered out of the planner's
  // base-SKU list by the GLOB filter, so their allocations never match any
  // planner row — causing blank 30d / LY monthly cells.
  //
  // Fix: resolve any allocation SKU that is a pack variant of a known base unit,
  // and roll its units up to that base unit. Operates on allInvSkuSet (planner
  // base units only) so we never roll up to a filtered-out variant.
  //
  // For AggRow maps (cur90/ly90/lyHoriz) we sum depleted + in_stock_days MAX.
  // For scalar maps (cur30/lyMonths) we sum units directly.

  // Build a case-insensitive base-unit resolver that handles AM-prefixed inventory SKUs.
  // resolveBaseUnit checks entry.toLowerCase() === base.toLowerCase() — but if inventory
  // has "AM5252" and alloc strips AM to get base "5252", those don't match.
  // Solution: build a secondary lookup keyed by resolverNormalizeSku(sku) → sku.
  const normToInventorySku = new Map<string, string>();
  for (const invSku of allInvSkuSet) {
    const normalized = resolverNormalizeSku(invSku); // strips AM prefix
    if (!normToInventorySku.has(normalized)) normToInventorySku.set(normalized, invSku);
  }

  /**
   * Resolve an allocation SKU that is NOT in allInvSkuSet to a planner base unit.
   * Steps: strip AM → parsePack to get base → try resolveBaseUnit → fallback to normToInventorySku.
   */
  function resolveToBase(allocSku: string): string | null {
    const norm = resolverNormalizeSku(allocSku);          // strip AM, quotes, etc.
    const { base: packBase } = parsePack(norm);           // strip pack suffix
    // First try resolveBaseUnit (handles -1 suffix variants)
    const resolved = resolveBaseUnit(packBase, allInvSkuSet);
    if (resolved) return resolved;
    // Fallback: direct lookup by normalized key, also try packBase + '-1'
    return normToInventorySku.get(packBase)
      ?? normToInventorySku.get(packBase + '-1')
      ?? null;
  }

  function rollupPackVariantsScalar(m: Map<string, number>): void {
    // Build list of entries first to avoid mutating while iterating
    const entries = [...m.entries()];
    for (const [allocSku, units] of entries) {
      // Skip if already a known planner base unit
      if (allInvSkuSet.has(allocSku)) continue;
      const resolvedBase = resolveToBase(allocSku);
      if (!resolvedBase) continue;
      // Roll up into the resolved base unit
      m.set(resolvedBase, (m.get(resolvedBase) ?? 0) + units);
    }
  }

  function rollupPackVariantsAgg(m: Map<string, AggRow>): void {
    const entries = [...m.entries()];
    for (const [allocSku, agg] of entries) {
      if (allInvSkuSet.has(allocSku)) continue;
      const resolvedBase = resolveToBase(allocSku);
      if (!resolvedBase) continue;
      const existing = m.get(resolvedBase) ?? { depleted: 0, in_stock_days: 0, order_count: 0, avg_order_size: 0 };
      m.set(resolvedBase, {
        depleted:       existing.depleted + agg.depleted,
        in_stock_days:  Math.max(existing.in_stock_days, agg.in_stock_days),
        order_count:    existing.order_count + agg.order_count,
        avg_order_size: existing.avg_order_size, // keep base unit's own avg
      });
    }
  }

  rollupPackVariantsAgg(cur90Map);
  rollupPackVariantsAgg(ly90Map);
  rollupPackVariantsAgg(lyHorizMap);
  rollupPackVariantsScalar(cur30Map);
  for (const mm of lyMonthMaps) rollupPackVariantsScalar(mm);

  const mappingsMap = await getPhysicalSkuMappingsMap();

  const rows: RestockRow[] = [];
  // Internal map: sku → {moq, case_pack_qty} for use in family merge.
  // Not exposed on RestockRow to keep the public interface clean.
  const skuPackMeta = new Map<string, { moq: number; casePack: number }>();

  for (const inv of invResult.rows) {
    const sku          = inv.sku as string;
    const title        = (inv.title as string) ?? sku;
    // On-hand = current_qty from inventory_products only.
    // Pack combo stock (AM5233-2, AM5233-5, etc.) is NOT added here —
    // Teapplix does not hold separate pre-packed stock; those units are
    // already reflected in the base SKU's current_qty.
    const onHand  = Number(inv.current_qty);
    // Fix 1: on_order from open POs, not hardcoded 0.
    const onOrder = openPoMap.get(sku) ?? 0;

    // Fix 2: per-SKU lead time. Use per-SKU column when set, fall back to
    // origin-based constant, then global default. Flag SKUs using the default.
    const skuLeadTime = inv.lead_time_days != null ? Number(inv.lead_time_days) : null;
    const originLeadTime = inv.supplier_origin != null
      ? (LEAD_TIME_DAYS[(inv.supplier_origin as string).toLowerCase()] ?? null)
      : null;
    const usingDefaultLeadTime = skuLeadTime === null && originLeadTime === null;
    const leadTime = skuLeadTime ?? originLeadTime ?? LEAD_TIME_DAYS['default'];
    const horizon    = leadTime + COVERAGE_DAYS;
    const safetyDays = Math.round(leadTime * 0.25);

    const cur90   = cur90Map.get(sku)   ?? { depleted: 0, in_stock_days: 0, order_count: 0, avg_order_size: 0 };
    if (sku.includes('5303')) console.log(`[DEBUG 5303] sku=${sku} cur90=`, cur90, 'cur90Start=', cur90Start, 'snapDays=', snapCur90Map.get(sku));
    const ly90    = ly90Map.get(sku)    ?? { depleted: 0, in_stock_days: 0 };
    const lyHoriz = lyHorizMap.get(sku) ?? { depleted: 0, in_stock_days: 0 };

    // In-stock days: take MAX of snapshot count and order-date count.
    // Snapshot preferred when healthy, but if snapshots are sparse/missing
    // (e.g. sync gaps) the order-date count is the better floor.
    // Using strict priority (snapshot-only) caused items with full stock but
    // incomplete snapshot history to show OOS corrections erroneously.
    //
    // Additional guard: if the item currently has stock (onHand > 0) AND the
    // snapshot table is immature (< 30 days of data — i.e. recently seeded),
    // assume the item was in stock for the full 90-day window. This prevents
    // false OOS corrections for slow-moving items that sell on few days but
    // have never been out of stock. The order-date count only measures days
    // with SALES, not days with STOCK — a slow-mover selling on 16/90 days
    // with 200+ units on hand is NOT an OOS item.
    const snapDaysCur = snapCur90Map.has(sku) ? snapCur90Map.get(sku)! : 0;
    const snapMature  = snapDaysCur >= 30; // trust snapshots only once 30+ days of data exist
    const curInStockDays  = onHand > 0 && !snapMature
      ? 90  // item has stock + snapshots too young → assume fully in stock
      : Math.max(snapDaysCur, cur90.in_stock_days);
    const ly90InStockDays = Math.max(
      snapLy90Map.has(sku)  ? snapLy90Map.get(sku)!  : 0,
      ly90.in_stock_days,
    );
    const curInStock      = Math.max(curInStockDays, 1);
    const curOosDays      = Math.max(0, 90 - curInStockDays);
    const lyOosDays90     = Math.max(0, 90 - ly90InStockDays);

    // ── Velocity (OOS-corrected) ──────────────────────────────────────────
    // rawVelocity = depleted / in-stock days = OOS-corrected run rate
    // Ceiling: prevent extreme inflation when only 1–2 days were in-stock.
    // Cap at 2.0× the uncorrected rate (depleted/90). This allows up to
    // ~45 OOS days out of 90 to be fully corrected without capping.
    // For normal in-stock periods (50–89 days) this is effectively a no-op.
    //
    // Bulk-order bypass: if in_stock_days < 10 AND avg order size ≥ 10 units,
    // this SKU sells in wholesale/bulk batches, not daily consumer velocity.
    // OOS correction assumes stock-outs between sale days — that's wrong for
    // bulk SKUs which simply don't sell every day by nature.
    // Bypass: use uncorrected rate (depleted / 90) directly. No OOS multiplier.
    const VELOCITY_CEILING_FACTOR = 2.0;
    const BULK_TRADING_DAY_MAX    = 10;  // fewer trading days than this = sparse seller
    const BULK_AVG_ORDER_MIN      = 10;  // avg order ≥ this = bulk/wholesale pattern
    const isBulkPattern =
      cur90.in_stock_days > 0 &&
      cur90.in_stock_days < BULK_TRADING_DAY_MAX &&
      cur90.avg_order_size >= BULK_AVG_ORDER_MIN;
    const rawVelocity     = cur90.depleted / curInStock;
    const uncorrectedRate = cur90.depleted / 90;
    const ceiling         = uncorrectedRate * VELOCITY_CEILING_FACTOR;
    // Bulk pattern: skip OOS correction, use plain uncorrected rate.
    // Normal pattern: OOS-correct but cap at ceiling.
    const velocity        = isBulkPattern
      ? uncorrectedRate
      : Math.min(rawVelocity, ceiling);
    const velocityAdj     = !isBulkPattern && curInStockDays < 90 && curInStockDays >= 1;

    // ── YoY growth ────────────────────────────────────────────────────────
    const fastEnough = ly90InStockDays >= MIN_OOS_DAYS;
    let ly90Base: number;
    if (fastEnough && ly90InStockDays > 0) {
      const reconstructed = (ly90.depleted / ly90InStockDays) * 90;
      ly90Base = Math.min(reconstructed, ly90.depleted * OOS_RECON_CAP);
    } else {
      ly90Base = ly90.depleted;
    }

    let growth: number;
    const hasLyData = ly90Base > 0;
    if (hasLyData) {
      const rawG = cur90.depleted / ly90Base;
      growth = Math.max(MIN_GROWTH_FLOOR, Math.min(MAX_GROWTH_CAP, rawG));
    } else {
      growth = 0.90; // conservative fallback per spec
    }

    // ── Fix 4: Velocity forecast — no growth double-count ─────────────────
    // growth already embedded in velocity (cur90 reflects this year's level).
    // Apply growth only to the LY-derived seasonal half.
    const velForecast = velocity * horizon;  // current run rate, no growth multiplier

    // ── Fix 2: Liquidation / wind-down detection ──────────────────────────
    const lyDailyRate = ly90Base / 90;
    const isDeclining = lyDailyRate > 0 && velocity < lyDailyRate * 0.25;

    // ── Seasonal forecast (LY horizon window, OOS-corrected) ──────────────
    // Fix 2: if declining, skip LY horizon — it was a one-time drawdown
    let seasForecast = 0;
    let lyHorizBase = 0;
    const lyHorizInStock = lyHoriz.in_stock_days; // no snapshot for horizon window
    if (hasLyData && lyHoriz.depleted > 0 && !isDeclining) {
      if (fastEnough && lyHorizInStock >= MIN_OOS_DAYS) {
        const reconstructed = (lyHoriz.depleted / lyHorizInStock) * horizon;
        lyHorizBase = Math.min(reconstructed, lyHoriz.depleted * OOS_RECON_CAP);
      } else {
        lyHorizBase = lyHoriz.depleted;
      }
      // Fix 4: growth applied here (LY-derived half only)
      seasForecast = lyHorizBase * growth;
    }

    // ── Blended forecast ──────────────────────────────────────────────────
    const forecast = hasLyData && seasForecast > 0
      ? (1 - SEASONAL_WEIGHT) * velForecast + SEASONAL_WEIGHT * seasForecast
      : velForecast;

    // ── Procurement ───────────────────────────────────────────────────────
    const safetyStock    = velocity * safetyDays;
    const target         = forecast + safetyStock;
    const daysOfCover    = velocity > 0 ? (onHand + onOrder) / velocity : null;
    const reorderTrigger = leadTime + safetyDays;

    // Fix 3: reasonableness cap — history can inform, never dictate
    const orderCap = velocity > 0 ? Math.ceil(velocity * horizon * 2) : 0;
    let orderNow = Math.max(0, Math.ceil(target - onHand - onOrder));
    orderNow = Math.min(orderNow, orderCap);

    // Fix 1: cover guard (highest priority)
    if (daysOfCover !== null && daysOfCover > horizon) {
      orderNow = 0;
    }

    // Fix 6: status priority — first match wins
    let status: RestockRow['status'];
    let statusDriver: string;
    if (daysOfCover !== null && daysOfCover > horizon) {
      status = 'OVERSTOCKED';
      statusDriver = `daysOfCover(${Math.round(daysOfCover)}) > horizon(${horizon})`;
    } else if (isDeclining) {
      status = 'DECLINING';
      statusDriver = `velocity(${velocity.toFixed(3)}) < lyDailyRate(${lyDailyRate.toFixed(3)}) * 0.25`;
    } else if (daysOfCover === null || daysOfCover < reorderTrigger) {
      status = 'REORDER NOW';
      statusDriver = daysOfCover === null ? 'velocity=0' : `daysOfCover(${Math.round(daysOfCover)}) < reorderTrigger(${reorderTrigger})`;
    } else {
      status = 'OK';
      statusDriver = `daysOfCover(${Math.round(daysOfCover)}) >= reorderTrigger(${reorderTrigger})`;
    }

    // Fix 5: dev log — surface both stock bases for mismatch detection
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[restock:${sku}] onHand(current_qty)=${onHand} | onOrder=${onOrder} | src=order_lines | lyDailyRate=${lyDailyRate.toFixed(3)} | velForecast=${Math.round(velForecast)} | seasForecast=${Math.round(seasForecast)} | daysOfCover=${daysOfCover !== null ? Math.round(daysOfCover) : 'null'} | orderNow=${orderNow} | status=${status}`);
    }

    // Fix 3: compute order_moq — round order_now UP to next case_pack_qty, never below moq.
    // Underlying demand math (order_now) is unchanged.
    const skuCasePack = inv.case_pack_qty != null ? Number(inv.case_pack_qty) : 1;
    const skuMoq      = inv.moq != null ? Number(inv.moq) : 0;
    let orderMoq: number;
    if (orderNow === 0) {
      orderMoq = 0;
    } else {
      // Round up to nearest case pack
      const casePack = skuCasePack > 1 ? skuCasePack : 1;
      const roundedUp = Math.ceil(orderNow / casePack) * casePack;
      orderMoq = Math.max(roundedUp, skuMoq);
    }

    // Stash pack meta for family-merge MOQ calculation
    skuPackMeta.set(sku, { moq: skuMoq, casePack: skuCasePack });

    // Confidence / trust flags (surface only — do NOT change math)
    const confidenceFlags: string[] = [];
    if (!hasLyData) confidenceFlags.push('velocity_only_no_ly');
    if (!snapMature) confidenceFlags.push('immature_snapshots');
    if (usingDefaultLeadTime) confidenceFlags.push('default_lead_time');
    if (isBulkPattern) confidenceFlags.push('bulk_order_pattern');

    const storefrontMappings = mappingsMap.get(sku) ?? [];

    const lyMonthlyUnits: LyMonthlyUnits[] = lyMonthBoundaries.map((b, i) => ({
      month: b.label,
      year: b.year,
      monthNum: b.month,
      units: lyMonthMaps[i].get(sku) ?? lyMonthMaps[i].get(resolverNormalizeSku(sku)) ?? 0,
    }));

    const units30d = cur30Map.get(sku) ?? cur30Map.get(resolverNormalizeSku(sku)) ?? 0;

    rows.push({
      sku,
      item_title:             title,
      qty_available:          onHand,
      on_order:               onOrder,
      velocity_90d:           Math.round(velocity * 100) / 100,
      velocity_adj:           velocityAdj,
      velocity_in_stock_days: curInStockDays,
      lead_time_days:         leadTime,
      days_of_cover:          daysOfCover !== null ? Math.round(daysOfCover) : null,
      forecast:               Math.round(forecast),
      vel_forecast:           Math.round(velForecast),
      seas_forecast:          Math.round(seasForecast),
      growth_multiplier:      Math.round(growth * 100) / 100,
      has_ly_data:            hasLyData,
      safety_stock:           Math.round(safetyStock),
      order_now:              orderNow,
      order_moq:              orderMoq,
      status,
      ly_daily_rate:          Math.round(lyDailyRate * 1000) / 1000,
      is_declining:           isDeclining,
      status_driver:          statusDriver,
      ly_horiz_base:          lyHorizBase,
      raw_depleted_90d:       cur90.depleted,
      ly_monthly_units:       lyMonthlyUnits,
      units_30d:              units30d,
      // legacy aliases
      cur_oos_days:           curOosDays,
      ly_oos_days_90:         lyOosDays90,
      projected_5m_need:      Math.round(forecast),
      recommended_order:      orderMoq,
      storefront_mappings:    storefrontMappings,
      confidence_flags:       confidenceFlags,
    });
  }

  // ── Family merge — collapse pack variants into one row ────────────────────
  // Model B: each pack SKU (AM5234-1, AM5234-2, AM5234-5, AM5234-10, AM5234-five)
  // carries its own pre-packed stock count from Teapplix. On-hand must be
  // converted to base units: qty × pack_size for each variant, then summed.
  //
  // Additionally, AM-prefixed SKUs (Amazon channel) and their non-AM counterparts
  // (e.g. AM5234-1 + 5234-1) track the same physical item across channels.
  // These must merge into one row — canonical SKU = the non-AM version if it exists.
  //
  // Algorithm:
  //   1. Normalize family key: strip AM prefix before getFamilySku so
  //      AM5234-1 and 5234-1 both → family "5234"
  //   2. Group all rows by normalized family key
  //   3. Within each family, on-hand = sum(qty_available × pack_size)
  //      but use the highest-stock member's qty as the stock truth (avoid double-count
  //      when AM and non-AM SKUs track the same physical bin)
  //   4. Recompute velocity, forecast, order_now from merged totals

  const allRowSkus = new Set(rows.map((r) => r.sku));
  // Build a normalized SKU set via resolver.normalizeSku (strips AM prefix + other artifacts)
  // so AM5234-1 and 5234-1 both normalize to "5234-1" and share the same family key.
  const normalizedSkuSet = new Set(rows.map((r) => resolverNormalizeSku(r.sku)));

  // Normalize a SKU to its family key via resolver.normalizeSku, then getFamilySku for pack grouping.
  const toFamilyKey = (sku: string): string => {
    const normalized = resolverNormalizeSku(sku);
    return getFamilySku(normalized, normalizedSkuSet);
  };

  const familyMap = new Map<string, RestockRow[]>();
  for (const row of rows) {
    const family = toFamilyKey(row.sku);
    const bucket = familyMap.get(family) ?? [];
    bucket.push(row);
    familyMap.set(family, bucket);
  }

  const mergedRows: RestockRow[] = [];

  for (const [familyKey, members] of familyMap.entries()) {
    if (members.length === 1) {
      // No siblings — keep row as-is, just use normalized family key as label
      const r = { ...members[0], sku: familyKey };
      mergedRows.push(r);
      continue;
    }

    // Representative = member with highest qty_available (all are base units)
    const rep = members.reduce((best, m) => m.qty_available > best.qty_available ? m : best, members[0]);

    // All members are base-unit SKUs (pack variants excluded from invResult above),
    // so parsePack().qty = 1 for all. Simple sum of qty_available.
    const totalOnHand  = members.reduce((s, m) => s + m.qty_available, 0);
    const totalOnOrder = members.reduce((s, m) => s + m.on_order, 0);

    // Sum independent per-SKU velocities.
    // Old approach (SUM(depleted) / MAX(in_stock_days)) inflates velocity when members
    // have differing in_stock_days — a shared denominator doesn't represent any single
    // SKU's actual trading period. Summing velocity_90d (already OOS-corrected + ceiling-
    // capped per SKU) avoids this denominator mismatch entirely.
    //
    // Example: 5304-1 velocity=0.5/day, 5304-2 velocity=1.2/day → family=1.7/day.
    // Old formula: (depleted_A + depleted_B) / max(in_stock_days) could yield 2–10× that
    // if one member had far fewer in_stock_days than another.
    const mergedVelocity = Math.round(
      members.reduce((s, m) => s + m.velocity_90d, 0) * 100
    ) / 100;

    // Keep raw_depleted_90d for the output field (informational, not used in velocity math)
    const totalDepleted = members.reduce((s, m) => s + m.raw_depleted_90d, 0);
    // mergedInStockDays still needed for velocity_adj flag below
    const mergedInStockDays = Math.max(...members.map((m) => m.velocity_in_stock_days));

    const leadTime    = rep.lead_time_days;
    const horizon     = leadTime + COVERAGE_DAYS;
    const safetyDays  = Math.round(leadTime * 0.25);

    // Recompute forecast from merged velocity + summed LY horizon base across members
    const velForecast  = mergedVelocity * horizon;
    const growth       = rep.growth_multiplier;
    const hasLyData    = members.some((m) => m.has_ly_data);
    // Sum raw LY horizon base units across all family members
    const totalLyHorizBase = members.reduce((s, m) => s + m.ly_horiz_base, 0);
    const seasForecast = totalLyHorizBase > 0 ? Math.round(totalLyHorizBase * growth) : 0;
    const forecast = hasLyData && seasForecast > 0
      ? Math.round((1 - SEASONAL_WEIGHT) * velForecast + SEASONAL_WEIGHT * seasForecast)
      : Math.round(velForecast);

    const safetyStock    = Math.round(mergedVelocity * safetyDays);
    const target         = forecast + safetyStock;
    const daysOfCover    = mergedVelocity > 0 ? Math.round((totalOnHand + totalOnOrder) / mergedVelocity) : null;
    const reorderTrigger = leadTime + safetyDays;
    const orderCap       = mergedVelocity > 0 ? Math.ceil(mergedVelocity * horizon * 2) : 0;
    let orderNow = Math.max(0, Math.ceil(target - totalOnHand - totalOnOrder));
    orderNow = Math.min(orderNow, orderCap);
    if (daysOfCover !== null && daysOfCover > horizon) orderNow = 0;

    const isDeclining = rep.is_declining;
    if (isDeclining) orderNow = 0;

    // Fix 3: MOQ / case-pack rounding for merged row.
    // Use rep's case_pack_qty / moq — representative carries the authoritative values.
    // (Family members are pack variants of the same physical item; rep is highest-stock member.)
    const repMeta        = skuPackMeta.get(rep.sku);
    const mergedCasePack = repMeta?.casePack ?? 1;
    const mergedMoq      = repMeta?.moq ?? 0;
    let mergedOrderMoq: number;
    if (orderNow === 0) {
      mergedOrderMoq = 0;
    } else {
      const casePack = mergedCasePack > 1 ? mergedCasePack : 1;
      const roundedUp = Math.ceil(orderNow / casePack) * casePack;
      mergedOrderMoq = Math.max(roundedUp, mergedMoq);
    }

    // Merge confidence flags — union of all member flags
    const mergedConfidenceFlags = [...new Set(members.flatMap((m) => m.confidence_flags ?? []))];

    let status: RestockRow['status'];
    let statusDriver: string;
    if (daysOfCover !== null && daysOfCover > horizon) {
      status = 'OVERSTOCKED';
      statusDriver = `daysOfCover(${daysOfCover}) > horizon(${horizon})`;
    } else if (isDeclining) {
      status = 'DECLINING';
      statusDriver = rep.status_driver;
    } else if (daysOfCover === null || daysOfCover < reorderTrigger) {
      status = 'REORDER NOW';
      statusDriver = daysOfCover === null ? 'velocity=0' : `daysOfCover(${daysOfCover}) < reorderTrigger(${reorderTrigger})`;
    } else {
      status = 'OK';
      statusDriver = `daysOfCover(${daysOfCover}) >= reorderTrigger(${reorderTrigger})`;
    }

    // Merge storefront_mappings — deduplicate by storefront_sku+mapped_sku
    const allMappings: StorefrontMapping[] = [];
    const seenMappings = new Set<string>();
    for (const m of members) {
      for (const sm of m.storefront_mappings ?? []) {
        const key = `${sm.storefront_sku}|${sm.mapped_sku}`;
        if (!seenMappings.has(key)) {
          seenMappings.add(key);
          allMappings.push(sm);
        }
      }
    }

    // Sum LY monthly units across all family members
    const mergedLyMonthly: LyMonthlyUnits[] = rep.ly_monthly_units.map((repMonth) => ({
      ...repMonth,
      units: members.reduce((s, m) => {
        const match = m.ly_monthly_units.find((mm) => mm.month === repMonth.month);
        return s + (match?.units ?? 0);
      }, 0),
    }));

    mergedRows.push({
      sku:                    familyKey,
      item_title:             rep.item_title,
      qty_available:          totalOnHand,
      on_order:               totalOnOrder,
      velocity_90d:           mergedVelocity,
      velocity_adj:           mergedInStockDays < 90,
      velocity_in_stock_days: mergedInStockDays,
      lead_time_days:         leadTime,
      days_of_cover:          daysOfCover,
      forecast,
      vel_forecast:           Math.round(velForecast),
      seas_forecast:          Math.round(seasForecast),
      growth_multiplier:      growth,
      has_ly_data:            hasLyData,
      safety_stock:           safetyStock,
      order_now:              orderNow,
      order_moq:              mergedOrderMoq,
      status,
      ly_daily_rate:          rep.ly_daily_rate,
      is_declining:           isDeclining,
      status_driver:          statusDriver,
      ly_horiz_base:          totalLyHorizBase,
      raw_depleted_90d:       totalDepleted,
      ly_monthly_units:       mergedLyMonthly,
      units_30d:              members.reduce((s, m) => s + m.units_30d, 0),
      cur_oos_days:           rep.cur_oos_days,
      ly_oos_days_90:         rep.ly_oos_days_90,
      projected_5m_need:      forecast,
      recommended_order:      mergedOrderMoq,
      storefront_mappings:    allMappings,
      confidence_flags:       mergedConfidenceFlags,
    });
  }

  const result = mergedRows
    .filter((r) => r.velocity_90d > 0 || r.qty_available > 0)
    .sort((a, b) => b.order_now - a.order_now);

  restockPlanCache = { data: result, timestamp: now };
  return result;
}


// ---------------------------------------------------------------------------
// SKU Revenue — per-SKU revenue breakdown by month or year
// Uses order_lines (sold SKU), not inventory_allocations
// ---------------------------------------------------------------------------

export interface SkuRevenueResult {
  sku: string;
  period: string;
  qty_sold: number;
  revenue: number;
  order_count: number;
  avg_unit_price: number;
}

export async function getSkuRevenue(
  sku: string,
  type: 'month' | 'year',
  period: string
): Promise<SkuRevenueResult | null> {
  const db = getDb();

  let dateFilter: string;
  let args: (string | number)[];

  if (type === 'month') {
    // period = "YYYY-MM"
    dateFilter = `strftime('%Y-%m', order_date) = ?`;
    args = [period, sku, sku];
  } else {
    // period = "YYYY"
    dateFilter = `strftime('%Y', order_date) = ?`;
    args = [period, sku, sku];
  }

  const result = await db.execute({
    sql: `SELECT
            COALESCE(resolved_teapplix_sku, raw_storefront_sku) AS sku,
            SUM(qty_sold) AS qty_sold,
            SUM(revenue) AS revenue,
            COUNT(DISTINCT customer_order_id) AS order_count,
            SUM(revenue) / NULLIF(SUM(qty_sold), 0) AS avg_unit_price
          FROM order_lines
          WHERE ${dateFilter}
            AND (resolved_teapplix_sku = ? OR raw_storefront_sku = ?)
            AND mapping_status != 'unmapped'
          GROUP BY sku`,
    args,
  });

  if (result.rows.length === 0) return null;

  const r = result.rows[0];
  return {
    sku: r.sku as string,
    period,
    qty_sold: Number(r.qty_sold),
    revenue: Math.round(Number(r.revenue) * 100) / 100,
    order_count: Number(r.order_count),
    avg_unit_price: Math.round(Number(r.avg_unit_price) * 100) / 100,
  };
}

export async function getAllSkus(): Promise<string[]> {
  const db = getDb();
  const result = await db.execute(
    `SELECT DISTINCT COALESCE(resolved_teapplix_sku, raw_storefront_sku) AS sku
     FROM order_lines
     WHERE mapping_status != 'unmapped'
     ORDER BY sku ASC`
  );
  return result.rows.map((r) => r.sku as string).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Seasonal Restock Plan — Jun/Jul/Aug forecast based on prior year actuals
// ---------------------------------------------------------------------------

/** @deprecated Replaced by unified getRestockPlan(). Kept as stub to avoid import errors. */
export async function getSeasonalRestockPlan(): Promise<SeasonalRestockRow[]> {
  return [];
}


// ---------------------------------------------------------------------------
// Physical Daily Summaries
// Uses inventory_allocations (physical depletion), not order_lines.
// These are used by the dashboard to show what physically moved.
// ---------------------------------------------------------------------------

export interface PhysicalSkuRecord {
  sku: string;
  physical_sku: string;           // alias for sku — used by components
  quantityDepleted: number;
  qty_depleted: number;           // alias for quantityDepleted — used by components
  allocationCount: number;
  allocationType: 'direct' | 'combo_explode' | 'mixed';
  storefront_skus: { sku: string; qty: number }[];  // source storefront SKUs that drove this depletion
}

export interface PhysicalDailySummary {
  date: string;
  totalDepleted: number;
  skuCount: number;
  skus: PhysicalSkuRecord[];
}

export async function getPhysicalSummaries(days: number): Promise<PhysicalDailySummary[]> {
  const db = getDb();
  const startStr = getDateNDaysAgoInTz(days - 1);
  const endStr   = getTodayInTz();

  // Main aggregation per (order_date, inventory_sku)
  const result = await db.execute({
    sql: `SELECT
            ol.order_date AS depletion_date,
            ia.inventory_sku,
            SUM(ia.qty_depleted) AS qty_depleted,
            COUNT(*) AS allocation_count,
            MAX(ia.allocation_type) AS allocation_type
          FROM inventory_allocations ia
          JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
          WHERE ol.order_date >= ? AND ol.order_date <= ?
          GROUP BY ol.order_date, ia.inventory_sku
          ORDER BY depletion_date ASC, qty_depleted DESC`,
    args: [startStr, endStr],
  });

  // Storefront SKU breakdown per (order_date, inventory_sku)
  const sfResult = await db.execute({
    sql: `SELECT
            ol.order_date AS depletion_date,
            ia.inventory_sku,
            ia.source_storefront_sku AS sku,
            SUM(ia.qty_depleted) AS qty
          FROM inventory_allocations ia
          JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
          WHERE ol.order_date >= ? AND ol.order_date <= ?
          GROUP BY ol.order_date, ia.inventory_sku, ia.source_storefront_sku`,
    args: [startStr, endStr],
  });

  // Build storefront_skus lookup: "date|inventory_sku" → { sku, qty }[]
  const sfMap = new Map<string, { sku: string; qty: number }[]>();
  for (const r of sfResult.rows) {
    const key = `${r.depletion_date}|${r.inventory_sku}`;
    const list = sfMap.get(key) ?? [];
    list.push({ sku: r.sku as string, qty: Number(r.qty) });
    sfMap.set(key, list);
  }

  const byDate = new Map<string, PhysicalSkuRecord[]>();
  for (const r of result.rows) {
    const date = r.depletion_date as string;
    const invSku = r.inventory_sku as string;
    const qtyDepleted = Number(r.qty_depleted);
    const storefrontSkus = sfMap.get(`${date}|${invSku}`) ?? [];
    const list = byDate.get(date) ?? [];
    const record: PhysicalSkuRecord = {
      sku: invSku,
      physical_sku: invSku,
      quantityDepleted: qtyDepleted,
      qty_depleted: qtyDepleted,
      allocationCount: Number(r.allocation_count),
      allocationType: r.allocation_type as 'direct' | 'combo_explode',
      storefront_skus: storefrontSkus,
    };
    list.push(record);
    byDate.set(date, list);
  }

  return [...byDate.entries()].map(([date, skus]) => ({
    date,
    totalDepleted: skus.reduce((s, r) => s + r.quantityDepleted, 0),
    skuCount: skus.length,
    skus,
  }));
}

export async function getTodayPhysicalSummary(): Promise<PhysicalDailySummary | null> {
  const summaries = await getPhysicalSummaries(1);
  return summaries[0] ?? null;
}

// ---------------------------------------------------------------------------
// SkuRevenueSearchResult — richer type for the SkuRevenueSearch component
// ---------------------------------------------------------------------------

export interface SkuRevenueSearchResult {
  sku: string;
  period: string;
  totalRevenue: number;
  totalUnits: number;
  orderCount: number;
  avgUnitPrice: number;
  dailyTrend: { date: string; revenue: number; units: number }[];
}

export async function getSkuRevenueSearch(
  sku: string,
  type: 'month' | 'year',
  period: string
): Promise<SkuRevenueSearchResult | null> {
  const db = getDb();

  let dateFilter: string;
  let args: (string | number)[];

  if (type === 'month') {
    dateFilter = `strftime('%Y-%m', order_date) = ?`;
    args = [period, sku, sku];
  } else {
    dateFilter = `strftime('%Y', order_date) = ?`;
    args = [period, sku, sku];
  }

  const [summaryResult, trendResult] = await Promise.all([
    db.execute({
      sql: `SELECT
              COALESCE(resolved_teapplix_sku, raw_storefront_sku) AS sku,
              SUM(qty_sold) AS total_units,
              SUM(revenue) AS total_revenue,
              COUNT(DISTINCT customer_order_id) AS order_count,
              SUM(revenue) / NULLIF(SUM(qty_sold), 0) AS avg_unit_price
            FROM order_lines
            WHERE ${dateFilter}
              AND (resolved_teapplix_sku = ? OR raw_storefront_sku = ?)
              AND mapping_status != 'unmapped'
            GROUP BY sku`,
      args,
    }),
    db.execute({
      sql: `SELECT
              order_date,
              SUM(qty_sold) AS units,
              SUM(revenue) AS revenue
            FROM order_lines
            WHERE ${dateFilter}
              AND (resolved_teapplix_sku = ? OR raw_storefront_sku = ?)
              AND mapping_status != 'unmapped'
            GROUP BY order_date
            ORDER BY order_date ASC`,
      args,
    }),
  ]);

  if (summaryResult.rows.length === 0) return null;

  const s = summaryResult.rows[0];
  return {
    sku: s.sku as string,
    period,
    totalRevenue: Math.round(Number(s.total_revenue) * 100) / 100,
    totalUnits: Number(s.total_units),
    orderCount: Number(s.order_count),
    avgUnitPrice: Math.round(Number(s.avg_unit_price) * 100) / 100,
    dailyTrend: trendResult.rows.map((r) => ({
      date: r.order_date as string,
      revenue: Math.round(Number(r.revenue) * 100) / 100,
      units: Number(r.units),
    })),
  };
}

// ---------------------------------------------------------------------------
// Historical summaries — all years present in order_lines
// ---------------------------------------------------------------------------

/** Returns the distinct years that have order data, sorted descending. */
export async function getAvailableYears(): Promise<number[]> {
  const db = getDb();
  const result = await db.execute(
    `SELECT DISTINCT strftime('%Y', order_date) AS yr
     FROM order_lines
     WHERE mapping_status != 'unmapped'
     ORDER BY yr DESC`
  );
  return result.rows.map((r) => Number(r.yr)).filter((y) => !isNaN(y));
}

/**
 * Fetches summaries for every year that has data in order_lines and merges
 * them with the recent 90-day window.  The result covers the full history
 * so the Revenue-by-Year panel can show all years.
 * Optimized: Runs exactly two lightweight queries to avoid SKU-level groupings for history.
 */
export async function getAllHistoricalSummaries(): Promise<DailySummary[]> {
  const db = getDb();

  const [dayResult, cogsResult] = await Promise.all([
    db.execute(`
      SELECT order_date,
             COUNT(DISTINCT customer_order_id) AS order_count,
             SUM(revenue) AS total_revenue
      FROM order_lines
      WHERE mapping_status != 'unmapped'
      GROUP BY order_date ORDER BY order_date ASC
    `),
    db.execute(`
      SELECT ol.order_date,
             SUM(ia.qty_depleted * ip.unit_cost) AS total_cogs
      FROM inventory_allocations ia
      JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
      JOIN inventory_products ip ON ip.sku = ia.inventory_sku
      GROUP BY ol.order_date
    `)
  ]);

  const cogsMap = new Map<string, number>();
  for (const r of cogsResult.rows) {
    cogsMap.set(r.order_date as string, Number(r.total_cogs));
  }

  return dayResult.rows.map((r) => {
    const date = r.order_date as string;
    const orderCount = Number(r.order_count);
    const totalRevenue = Number(r.total_revenue);
    const cogs = cogsMap.get(date) ?? 0;
    const aov = orderCount > 0 ? totalRevenue / orderCount : 0;
    return {
      date,
      orderCount,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      aov: Math.round(aov * 100) / 100,
      cogs: Math.round(cogs * 100) / 100,
      skus: [], // Empty for historical years on load; on-demand year API fetches SKU charts if clicked
    };
  });
}

// ---------------------------------------------------------------------------
// SeasonalRestockRow — used by restock page
// ---------------------------------------------------------------------------

/** @deprecated Unified planner replaces seasonal tab. Kept as stub for legacy imports. */
export interface SeasonalRestockRow {
  sku: string;
  item_title: string;
  qty_available: number;
  jun_forecast: number;
  jul_forecast: number;
  aug_forecast: number;
  total_forecast: number;
  need_to_order: number;
  surplus_qty: number;
  growth_multiplier: number;
  status: 'ORDER' | 'SURPLUS';
  storefront_mappings?: StorefrontMapping[];
}



// ---------------------------------------------------------------------------
// Historical Stock Lookback — per-SKU end-of-month stock levels
// Primary source: inventory_snapshots (last snapshot of each month).
// Fallback: reconstruct from inventory_allocations when no snapshot exists.
// Covers: May 2025 + Jan–Dec 2024.
// ---------------------------------------------------------------------------

export interface StockHistoryPoint {
  year_month: string;   // "YYYY-MM"
  label: string;        // "May 2025", "Dec 2024", etc.
  qty_available: number | null;
  source: 'snapshot' | 'allocation_estimate' | 'no_data';
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
}

export async function getSkuStockHistory(sku: string): Promise<StockHistoryPoint[]> {
  const db = getDb();

  // Target periods: May 2025 + all 12 months of 2024, newest first
  const periods: string[] = ['2025-05'];
  for (let m = 12; m >= 1; m--) {
    periods.push(`2024-${String(m).padStart(2, '0')}`);
  }

  // 1. Fetch the last snapshot of each target month (authoritative when available)
  const snapResult = await db.execute({
    sql: `SELECT
            strftime('%Y-%m', snapshot_date) AS ym,
            qty_available
          FROM inventory_snapshots
          WHERE sku = ?
            AND (
              strftime('%Y-%m', snapshot_date) = '2025-05'
              OR strftime('%Y', snapshot_date) = '2024'
            )
            AND snapshot_date = (
              SELECT MAX(s2.snapshot_date)
              FROM inventory_snapshots s2
              WHERE s2.sku = inventory_snapshots.sku
                AND strftime('%Y-%m', s2.snapshot_date) = strftime('%Y-%m', inventory_snapshots.snapshot_date)
            )
          ORDER BY snapshot_date DESC`,
    args: [sku],
  });

  const snapMap = new Map<string, number>();
  for (const r of snapResult.rows) {
    snapMap.set(r.ym as string, Number(r.qty_available));
  }

  // 2. For months without snapshots, reconstruct from allocations.
  //    Formula: end_of_month_qty = current_qty + total_depletions_after_month_end
  //    Uses ALL allocation types (direct + combo_explode) — both represent real
  //    physical warehouse depletion. Numbers may be large for high-volume combo children.
  const missingPeriods = periods.filter((p) => !snapMap.has(p));
  const allocMap = new Map<string, number>();

  if (missingPeriods.length > 0) {
    const invRow = await db.execute({
      sql: `SELECT current_qty FROM inventory_products WHERE sku = ?`,
      args: [sku],
    });
    const currentQty = invRow.rows.length > 0 ? Number(invRow.rows[0].current_qty) : null;

    if (currentQty !== null) {
      // Fetch cumulative depletions after each month-end in a single query
      // using conditional aggregation to avoid N separate queries.
      // Build CASE expressions for each missing period.
      const cases = missingPeriods.map((period) => {
        const [y, m] = period.split('-').map(Number);
        const lastDay = new Date(y, m, 0).getDate();
        const periodEnd = `${period}-${String(lastDay).padStart(2, '0')}`;
        return { period, periodEnd };
      });

      // Run one query per period (SQLite doesn't support dynamic pivot easily)
      await Promise.all(
        cases.map(async ({ period, periodEnd }) => {
          const depResult = await db.execute({
            sql: `SELECT SUM(ia.qty_depleted) AS depleted
                  FROM inventory_allocations ia
                  JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
                  WHERE ia.inventory_sku = ?
                    AND ol.order_date > ?`,
            args: [sku, periodEnd],
          });
          const depleted = Number(depResult.rows[0]?.depleted ?? 0);
          allocMap.set(period, Math.max(0, currentQty + depleted));
        })
      );
    }
  }

  return periods.map((ym) => {
    if (snapMap.has(ym)) {
      return { year_month: ym, label: monthLabel(ym), qty_available: snapMap.get(ym)!, source: 'snapshot' as const };
    }
    if (allocMap.has(ym)) {
      return { year_month: ym, label: monthLabel(ym), qty_available: allocMap.get(ym)!, source: 'allocation_estimate' as const };
    }
    return { year_month: ym, label: monthLabel(ym), qty_available: null, source: 'no_data' as const };
  });
}

// ---------------------------------------------------------------------------
// Daily Marketing Spend — Amazon Vendor Central ad + coupon costs
// Used to compute true net profit: revenue - COGS - marketing_spend
// ---------------------------------------------------------------------------

export interface MarketingSpendRow {
  id: string;
  date: string;                   // YYYY-MM-DD
  ad_spend: number;
  coupon_redemption_spend: number;
  marketplace: string;
  updated_at?: number;
}

/** Upsert one or more daily marketing spend records. Idempotent. */
export async function upsertMarketingSpend(rows: Omit<MarketingSpendRow, 'id'>[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => {
        const id = `${r.date}|${r.marketplace}`;
        return {
          sql: `INSERT INTO daily_marketing_spend
                  (id, date, ad_spend, coupon_redemption_spend, marketplace, updated_at)
                VALUES (?, ?, ?, ?, ?, unixepoch())
                ON CONFLICT(id) DO UPDATE SET
                  ad_spend                = excluded.ad_spend,
                  coupon_redemption_spend = excluded.coupon_redemption_spend,
                  updated_at              = unixepoch()`,
          args: [id, r.date, r.ad_spend, r.coupon_redemption_spend, r.marketplace],
        };
      })
    );
  }
}

/** Fetch marketing spend rows within a date range (inclusive). */
export async function getMarketingSpend(
  startDate: string,
  endDate: string,
  marketplace?: string
): Promise<MarketingSpendRow[]> {
  const db = getDb();
  const args: (string | number)[] = [startDate, endDate];
  let marketplaceClause = '';
  if (marketplace) {
    marketplaceClause = ' AND marketplace = ?';
    args.push(marketplace);
  }
  const result = await db.execute({
    sql: `SELECT id, date, ad_spend, coupon_redemption_spend, marketplace, updated_at
          FROM daily_marketing_spend
          WHERE date >= ? AND date <= ?${marketplaceClause}
          ORDER BY date ASC`,
    args,
  });
  return result.rows.map((r) => ({
    id: r.id as string,
    date: r.date as string,
    ad_spend: Number(r.ad_spend),
    coupon_redemption_spend: Number(r.coupon_redemption_spend),
    marketplace: r.marketplace as string,
    updated_at: Number(r.updated_at),
  }));
}

/**
 * Build a date → total_marketing_spend map for a given window.
 * total = ad_spend + coupon_redemption_spend across all marketplaces.
 */
export async function getMarketingSpendMap(
  startDate: string,
  endDate: string
): Promise<Map<string, number>> {
  const rows = await getMarketingSpend(startDate, endDate);
  const map = new Map<string, number>();
  for (const r of rows) {
    const prev = map.get(r.date) ?? 0;
    map.set(r.date, prev + r.ad_spend + r.coupon_redemption_spend);
  }
  return map;
}

/**
 * Net profit summary for a date range.
 * net_profit = revenue - cogs - marketing_spend
 */
export interface NetProfitSummary {
  date: string;
  revenue: number;
  cogs: number;
  marketing_spend: number;
  net_profit: number;
}

export async function getNetProfitSummary(
  startDate: string,
  endDate: string,
  marketplace?: string
): Promise<NetProfitSummary[]> {
  const db = getDb();

  const mkClause = marketplace ? ` AND ol.marketplace = '${marketplace}'` : '';

  const [revenueResult, cogsResult, marketingRows] = await Promise.all([
    db.execute({
      sql: `SELECT ol.order_date AS date,
                   SUM(ol.revenue) AS revenue
            FROM order_lines ol
            WHERE ol.order_date >= ? AND ol.order_date <= ?
              AND ol.mapping_status != 'unmapped'${mkClause}
            GROUP BY ol.order_date
            ORDER BY ol.order_date ASC`,
      args: [startDate, endDate],
    }),
    db.execute({
      sql: `SELECT ol.order_date AS date,
                   SUM(ia.qty_depleted * ip.cost_of_goods_sold) AS cogs
            FROM inventory_allocations ia
            JOIN order_lines ol ON ol.order_line_id = ia.order_line_id
            JOIN inventory_products ip ON ip.sku = ia.inventory_sku
            WHERE ol.order_date >= ? AND ol.order_date <= ?${mkClause}
            GROUP BY ol.order_date`,
      args: [startDate, endDate],
    }),
    getMarketingSpend(startDate, endDate, marketplace),
  ]);

  const revenueMap = new Map<string, number>();
  for (const r of revenueResult.rows) revenueMap.set(r.date as string, Number(r.revenue));

  const cogsMap = new Map<string, number>();
  for (const r of cogsResult.rows) cogsMap.set(r.date as string, Number(r.cogs));

  const mktMap = new Map<string, number>();
  for (const r of marketingRows) {
    const prev = mktMap.get(r.date) ?? 0;
    mktMap.set(r.date, prev + r.ad_spend + r.coupon_redemption_spend);
  }

  // Union all dates
  const allDates = new Set([...revenueMap.keys(), ...cogsMap.keys(), ...mktMap.keys()]);
  const results: NetProfitSummary[] = [];
  for (const date of [...allDates].sort()) {
    const revenue = revenueMap.get(date) ?? 0;
    const cogs = cogsMap.get(date) ?? 0;
    const marketing_spend = mktMap.get(date) ?? 0;
    results.push({
      date,
      revenue: Math.round(revenue * 100) / 100,
      cogs: Math.round(cogs * 100) / 100,
      marketing_spend: Math.round(marketing_spend * 100) / 100,
      net_profit: Math.round((revenue - cogs - marketing_spend) * 100) / 100,
    });
  }
  return results;
}

export interface OrganizationCredentials {
  id?: number;
  organization_id?: string;
  teapplix_api_key?: string;
  amazon_refresh_token?: string;
  amazon_client_id?: string;
  amazon_client_secret?: string;
  created_at?: string;
  updated_at?: string;
}

export async function getOrganizationCredentials(organizationId?: string): Promise<OrganizationCredentials | null> {
  const db = getDb();
  try {
    const activeOrgId = organizationId ?? getOrgContext().orgId;
    let result;
    if (activeOrgId) {
      result = await db.execute({
        sql: `SELECT id, organization_id, teapplix_api_key, amazon_refresh_token, amazon_client_id, amazon_client_secret, created_at, updated_at
              FROM organization_credentials
              WHERE organization_id = ?
              LIMIT 1`,
        args: [activeOrgId],
      });
    } else {
      result = await db.execute(`
        SELECT id, organization_id, teapplix_api_key, amazon_refresh_token, amazon_client_id, amazon_client_secret, created_at, updated_at
        FROM organization_credentials
        LIMIT 1
      `);
    }
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    
    return {
      id: Number(row.id),
      organization_id: row.organization_id as string,
      teapplix_api_key: row.teapplix_api_key ? decrypt(row.teapplix_api_key as string) : undefined,
      amazon_refresh_token: row.amazon_refresh_token ? decrypt(row.amazon_refresh_token as string) : undefined,
      amazon_client_id: row.amazon_client_id ? decrypt(row.amazon_client_id as string) : undefined,
      amazon_client_secret: row.amazon_client_secret ? decrypt(row.amazon_client_secret as string) : undefined,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  } catch (error) {
    console.error('[getOrganizationCredentials] failed:', error);
    return null;
  }
}

export async function saveOrganizationCredentials(creds: {
  teapplix_api_key?: string | null;
  amazon_refresh_token?: string | null;
  amazon_client_id?: string | null;
  amazon_client_secret?: string | null;
}, organizationId?: string): Promise<void> {
  const db = getDb();
  const activeOrgId = organizationId ?? getOrgContext().orgId;
  
  if (!activeOrgId) {
    throw new Error('Cannot save credentials without organization_id');
  }
  
  // Fetch existing first to merge
  const existing = await getOrganizationCredentials(activeOrgId);
  
  const teapplix_api_key = creds.teapplix_api_key !== undefined
    ? (creds.teapplix_api_key ? encrypt(creds.teapplix_api_key) : null)
    : (existing?.teapplix_api_key ? encrypt(existing.teapplix_api_key) : null);
    
  const amazon_refresh_token = creds.amazon_refresh_token !== undefined
    ? (creds.amazon_refresh_token ? encrypt(creds.amazon_refresh_token) : null)
    : (existing?.amazon_refresh_token ? encrypt(existing.amazon_refresh_token) : null);
    
  const amazon_client_id = creds.amazon_client_id !== undefined
    ? (creds.amazon_client_id ? encrypt(creds.amazon_client_id) : null)
    : (existing?.amazon_client_id ? encrypt(existing.amazon_client_id) : null);
    
  const amazon_client_secret = creds.amazon_client_secret !== undefined
    ? (creds.amazon_client_secret ? encrypt(creds.amazon_client_secret) : null)
    : (existing?.amazon_client_secret ? encrypt(existing.amazon_client_secret) : null);

  await db.execute({
    sql: `INSERT OR REPLACE INTO organization_credentials
            (organization_id, teapplix_api_key, amazon_refresh_token, amazon_client_id, amazon_client_secret, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    args: [activeOrgId, teapplix_api_key, amazon_refresh_token, amazon_client_id, amazon_client_secret]
  });
}
