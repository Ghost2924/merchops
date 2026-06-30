import Papa from 'papaparse';
import { OrderRecord } from '../data/types';

// ---------------------------------------------------------------------------
// Multi-pack SKU normalization
// ---------------------------------------------------------------------------

// Word-based pack suffixes that map to a multiplier.
const WORD_PACK_SUFFIXES: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  eight: 8,
  ten: 10,
  twelve: 12,
};

/**
 * Canonical SKU normalization rules (applied in order):
 *
 * 1. Strip trailing `-1` suffix — it is a variant label meaning "single unit".
 *    "AM5233-1" → "AM5233". Qty multiplier stays 1.
 *    This matches the backfill behavior so historic and live keys align.
 *
 * 2. Numeric suffix ≥ 2 → pack multiplier. "AM5237-10" → base "AM5237", ×10.
 *
 * 3. Word suffix in WORD_PACK_SUFFIXES → strip suffix, apply multiplier.
 *
 * 4. No valid suffix → multiplier 1, SKU unchanged.
 */
export function parseMultiPackSku(sku: string): { baseSku: string; multiplier: number } {
  if (!sku || typeof sku !== 'string') {
    return { baseSku: '', multiplier: 1 };
  }

  const numMatch = sku.match(/^(.+)-(\d+)$/);
  if (numMatch) {
    const multiplier = parseInt(numMatch[2], 10);
    // Both -1 (variant label) and ≥2 (pack) strip the suffix.
    // -1 strips but keeps multiplier=1 (no qty change).
    return { baseSku: numMatch[1], multiplier: multiplier >= 2 ? multiplier : 1 };
  }

  // Word suffix
  const wordMatch = sku.match(/^(.+)-([a-zA-Z]+)$/);
  if (wordMatch) {
    const word = wordMatch[2].toLowerCase();
    if (word in WORD_PACK_SUFFIXES) {
      return { baseSku: wordMatch[1], multiplier: WORD_PACK_SUFFIXES[word] };
    }
  }

  return { baseSku: sku, multiplier: 1 };
}

/**
 * Normalizes a SKU + qty + total_price triple for multi-pack bundles.
 *
 * @deprecated Use the relational mapping pipeline (marketplace_item_mappings +
 * combo_product_recipes) instead. This function is retained only for CSV import
 * of legacy historical data where no mapping table entries exist yet.
 *
 * - baseSku: suffix stripped
 * - qty: multiplied by pack size
 * - unitPrice: total_price / new qty  (total_price invariant preserved)
 */
export function normalizeMultiPack(
  sku: string,
  qty: number,
  totalPrice: number
): { sku: string; qty: number; unitPrice: number; totalPrice: number } {
  if (!sku || typeof sku !== 'string') {
    return { sku: '', qty, unitPrice: qty > 0 ? totalPrice / qty : 0, totalPrice };
  }
  const { baseSku, multiplier } = parseMultiPackSku(sku);
  const normalizedQty = qty * multiplier;
  const unitPrice = normalizedQty > 0 ? totalPrice / normalizedQty : 0;
  return {
    sku: baseSku,
    qty: normalizedQty,
    unitPrice: Math.round(unitPrice * 100) / 100,
    totalPrice: Math.round(totalPrice * 100) / 100,
  };
}

interface RawRow {
  'Order Date'?: string;
  'Payment Date'?: string;
  'SKU'?: string;
  'Qty'?: string;
  'Unit Price'?: string;
  'Total'?: string;
  [key: string]: string | undefined;
}

export function parseTeapplixCsv(csv: string): OrderRecord[] {
  const result = Papa.parse<RawRow>(csv, {
    header: true,
    skipEmptyLines: true,
  });

  const records: OrderRecord[] = [];

  result.data.forEach((row, index) => {
    const orderDate = row['Order Date']?.trim();
    const paymentDate = row['Payment Date']?.trim();
    const sku = row['SKU']?.trim();
    const qtyStr = row['Qty']?.trim();
    const unitPriceStr = row['Unit Price']?.trim();
    const totalStr = row['Total']?.trim();

    if (!orderDate || !paymentDate || !sku || !qtyStr || !unitPriceStr || !totalStr) {
      console.warn(`[parseTeapplixCsv] Skipping row ${index}: missing required fields`, row);
      return;
    }

    const quantity = Number(qtyStr);
    const unitPrice = Number(unitPriceStr);
    const totalRevenue = Number(totalStr);

    if (isNaN(quantity) || isNaN(unitPrice) || isNaN(totalRevenue)) {
      console.warn(`[parseTeapplixCsv] Skipping row ${index}: non-numeric values`, row);
      return;
    }

    const normalized = normalizeMultiPack(sku, quantity, totalRevenue);

    records.push({
      orderDate,
      paymentDate,
      sku: normalized.sku,
      quantity: normalized.qty,
      unitPrice: normalized.unitPrice,
      totalRevenue: normalized.totalPrice,
    });
  });

  return records;
}
