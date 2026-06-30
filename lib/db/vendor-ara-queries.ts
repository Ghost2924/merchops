/**
 * DB read/write helpers for ARA (Vendor Central) tables:
 *   vendor_ara_metrics       – one row per ASIN per reporting period
 *   vendor_inventory_health  – one row per ASIN per snapshot date
 *
 * Follows the same batched-upsert pattern as the rest of lib/db/queries.ts.
 */

import { getDb } from './turso';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AraMetricPeriodType = 'DAY' | 'WEEK' | 'MONTH';

export interface VendorAraMetricRow {
  asin: string;
  period_start: string;          // YYYY-MM-DD
  period_end: string;            // YYYY-MM-DD
  period_type: AraMetricPeriodType;
  shipped_revenue: number | null;
  shipped_cogs: number | null;
  ordered_units: number | null;
  shipped_units: number | null;
  customer_returns: number | null;
  net_ppm: number | null;
  sales_discount: number | null;
  currency: string;
}

export interface VendorInventoryHealthRow {
  asin: string;
  snapshot_date: string;         // YYYY-MM-DD
  roos_percent: number | null;
  sellable_on_hand_units: number | null;
  open_po_units: number | null;
  unfilled_customer_ordered_units: number | null;
}

// ---------------------------------------------------------------------------
// vendor_ara_metrics — write
// ---------------------------------------------------------------------------

const ARA_BATCH = 100;

export async function upsertVendorAraMetrics(rows: VendorAraMetricRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();

  for (let i = 0; i < rows.length; i += ARA_BATCH) {
    const chunk = rows.slice(i, i + ARA_BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO vendor_ara_metrics
                (asin, period_start, period_end, period_type,
                 shipped_revenue, shipped_cogs, ordered_units, shipped_units,
                 customer_returns, net_ppm, sales_discount, currency, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(asin, period_start, period_end, period_type) DO UPDATE SET
                shipped_revenue  = excluded.shipped_revenue,
                shipped_cogs     = excluded.shipped_cogs,
                ordered_units    = excluded.ordered_units,
                shipped_units    = excluded.shipped_units,
                customer_returns = excluded.customer_returns,
                net_ppm          = excluded.net_ppm,
                sales_discount   = excluded.sales_discount,
                currency         = excluded.currency,
                updated_at       = datetime('now')`,
        args: [
          r.asin,
          r.period_start,
          r.period_end,
          r.period_type,
          r.shipped_revenue ?? null,
          r.shipped_cogs ?? null,
          r.ordered_units ?? null,
          r.shipped_units ?? null,
          r.customer_returns ?? null,
          r.net_ppm ?? null,
          r.sales_discount ?? null,
          r.currency,
        ],
      }))
    );
  }
}

// ---------------------------------------------------------------------------
// vendor_ara_metrics — read
// ---------------------------------------------------------------------------

export async function getVendorAraMetrics(opts: {
  asin?: string;
  periodType?: AraMetricPeriodType;
  startDate?: string;  // inclusive YYYY-MM-DD
  endDate?: string;    // inclusive YYYY-MM-DD
  limit?: number;
}): Promise<VendorAraMetricRow[]> {
  const db = getDb();

  const conditions: string[] = [];
  const args: (string | number)[] = [];

  if (opts.asin) {
    conditions.push('asin = ?');
    args.push(opts.asin);
  }
  if (opts.periodType) {
    conditions.push('period_type = ?');
    args.push(opts.periodType);
  }
  if (opts.startDate) {
    conditions.push('period_start >= ?');
    args.push(opts.startDate);
  }
  if (opts.endDate) {
    conditions.push('period_end <= ?');
    args.push(opts.endDate);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitClause = opts.limit ? `LIMIT ${opts.limit}` : '';

  const result = await db.execute({
    sql: `SELECT asin, period_start, period_end, period_type,
                 shipped_revenue, shipped_cogs, ordered_units, shipped_units,
                 customer_returns, net_ppm, sales_discount, currency
          FROM vendor_ara_metrics
          ${where}
          ORDER BY period_start DESC, asin ASC
          ${limitClause}`,
    args,
  });

  return result.rows.map((r) => ({
    asin: r.asin as string,
    period_start: r.period_start as string,
    period_end: r.period_end as string,
    period_type: r.period_type as AraMetricPeriodType,
    shipped_revenue: r.shipped_revenue != null ? Number(r.shipped_revenue) : null,
    shipped_cogs: r.shipped_cogs != null ? Number(r.shipped_cogs) : null,
    ordered_units: r.ordered_units != null ? Number(r.ordered_units) : null,
    shipped_units: r.shipped_units != null ? Number(r.shipped_units) : null,
    customer_returns: r.customer_returns != null ? Number(r.customer_returns) : null,
    net_ppm: r.net_ppm != null ? Number(r.net_ppm) : null,
    sales_discount: r.sales_discount != null ? Number(r.sales_discount) : null,
    currency: r.currency as string,
  }));
}

// ---------------------------------------------------------------------------
// vendor_inventory_health — write
// ---------------------------------------------------------------------------

export async function upsertVendorInventoryHealth(rows: VendorInventoryHealthRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();

  for (let i = 0; i < rows.length; i += ARA_BATCH) {
    const chunk = rows.slice(i, i + ARA_BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO vendor_inventory_health
                (asin, snapshot_date, roos_percent, sellable_on_hand_units,
                 open_po_units, unfilled_customer_ordered_units, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(asin, snapshot_date) DO UPDATE SET
                roos_percent                    = excluded.roos_percent,
                sellable_on_hand_units          = excluded.sellable_on_hand_units,
                open_po_units                   = excluded.open_po_units,
                unfilled_customer_ordered_units = excluded.unfilled_customer_ordered_units,
                updated_at                      = datetime('now')`,
        args: [
          r.asin,
          r.snapshot_date,
          r.roos_percent ?? null,
          r.sellable_on_hand_units ?? null,
          r.open_po_units ?? null,
          r.unfilled_customer_ordered_units ?? null,
        ],
      }))
    );
  }
}

// ---------------------------------------------------------------------------
// vendor_inventory_health — read
// ---------------------------------------------------------------------------

export async function getVendorInventoryHealth(opts: {
  asin?: string;
  snapshotDate?: string;  // exact YYYY-MM-DD
  startDate?: string;     // inclusive
  endDate?: string;       // inclusive
  limit?: number;
}): Promise<VendorInventoryHealthRow[]> {
  const db = getDb();

  const conditions: string[] = [];
  const args: (string | number)[] = [];

  if (opts.asin) {
    conditions.push('asin = ?');
    args.push(opts.asin);
  }
  if (opts.snapshotDate) {
    conditions.push('snapshot_date = ?');
    args.push(opts.snapshotDate);
  }
  if (opts.startDate) {
    conditions.push('snapshot_date >= ?');
    args.push(opts.startDate);
  }
  if (opts.endDate) {
    conditions.push('snapshot_date <= ?');
    args.push(opts.endDate);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitClause = opts.limit ? `LIMIT ${opts.limit}` : '';

  const result = await db.execute({
    sql: `SELECT asin, snapshot_date, roos_percent, sellable_on_hand_units,
                 open_po_units, unfilled_customer_ordered_units
          FROM vendor_inventory_health
          ${where}
          ORDER BY snapshot_date DESC, asin ASC
          ${limitClause}`,
    args,
  });

  return result.rows.map((r) => ({
    asin: r.asin as string,
    snapshot_date: r.snapshot_date as string,
    roos_percent: r.roos_percent != null ? Number(r.roos_percent) : null,
    sellable_on_hand_units: r.sellable_on_hand_units != null ? Number(r.sellable_on_hand_units) : null,
    open_po_units: r.open_po_units != null ? Number(r.open_po_units) : null,
    unfilled_customer_ordered_units:
      r.unfilled_customer_ordered_units != null ? Number(r.unfilled_customer_ordered_units) : null,
  }));
}

// ---------------------------------------------------------------------------
// Convenience: latest health snapshot per ASIN
// ---------------------------------------------------------------------------

export async function getLatestVendorInventoryHealth(): Promise<VendorInventoryHealthRow[]> {
  const db = getDb();

  const result = await db.execute(`
    SELECT asin, snapshot_date, roos_percent, sellable_on_hand_units,
           open_po_units, unfilled_customer_ordered_units
    FROM vendor_inventory_health
    WHERE snapshot_date = (
      SELECT MAX(snapshot_date) FROM vendor_inventory_health
    )
    ORDER BY asin ASC
  `);

  return result.rows.map((r) => ({
    asin: r.asin as string,
    snapshot_date: r.snapshot_date as string,
    roos_percent: r.roos_percent != null ? Number(r.roos_percent) : null,
    sellable_on_hand_units: r.sellable_on_hand_units != null ? Number(r.sellable_on_hand_units) : null,
    open_po_units: r.open_po_units != null ? Number(r.open_po_units) : null,
    unfilled_customer_ordered_units:
      r.unfilled_customer_ordered_units != null ? Number(r.unfilled_customer_ordered_units) : null,
  }));
}
