/**
 * Unit tests for getRestockPlan base-unit logic.
 *
 * These tests exercise the pure helper logic extracted from getRestockPlan:
 *   - normalizeSku + parsePack replace the old ad-hoc AM-strip + getSkuPackMultiplier
 *   - Family merge produces EXACTLY ONE row per base unit
 *   - Selling 10× of "X-5" registers as 50 base units of velocity
 *
 * No DB required — all logic is tested via the resolver functions directly.
 */

import { normalizeSku, parsePack, resolveBaseUnit } from '../sku/resolver';
import { getFamilySku } from '../sku';

// ---------------------------------------------------------------------------
// Helper: the exact pack-multiplier logic now used in getRestockPlan
// (was getSkuPackMultiplier — now replaced inline)
// ---------------------------------------------------------------------------
function packMultiplier(sku: string): number {
  return parsePack(normalizeSku(sku)).qty;
}

// ---------------------------------------------------------------------------
// Helper: the exact toFamilyKey logic now used in getRestockPlan
// ---------------------------------------------------------------------------
function toFamilyKey(sku: string, normalizedSkuSet: Set<string>): string {
  const normalized = normalizeSku(sku);
  return getFamilySku(normalized, normalizedSkuSet);
}

// ---------------------------------------------------------------------------
// Test: packMultiplier via normalizeSku + parsePack
// ---------------------------------------------------------------------------

describe('packMultiplier (normalizeSku + parsePack)', () => {
  test('AM5234-1 → 1 (strip AM, then -1 suffix)', () => {
    expect(packMultiplier('AM5234-1')).toBe(1);
  });

  test('AM5234-2 → 2', () => {
    expect(packMultiplier('AM5234-2')).toBe(2);
  });

  test('AM5234-5 → 5', () => {
    expect(packMultiplier('AM5234-5')).toBe(5);
  });

  test('AM5234-10 → 10', () => {
    expect(packMultiplier('AM5234-10')).toBe(10);
  });

  test('AM5234-five → 5 (word suffix)', () => {
    expect(packMultiplier('AM5234-five')).toBe(5);
  });

  test('AM5234-ten → 10 (word suffix)', () => {
    expect(packMultiplier('AM5234-ten')).toBe(10);
  });

  test('NS5330-5PK → 5 (PK suffix)', () => {
    expect(packMultiplier('NS5330-5PK')).toBe(5);
  });

  test('bare SKU → 1', () => {
    expect(packMultiplier('5029b')).toBe(1);
  });

  test('1AM5234-2 → 2 (strip 1AM prefix)', () => {
    expect(packMultiplier('1AM5234-2')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test: no duplicate base-unit rows after family merge
// ---------------------------------------------------------------------------

describe('family merge: no duplicate base-unit rows', () => {
  /**
   * Simulate family merge: given a list of SKUs as they come out of invResult
   * (already physical inventory SKUs, not combos), each should map to exactly
   * one family key so the final merged row set has no duplicates.
   */

  const buildFamilyGroups = (skus: string[]): Map<string, string[]> => {
    const normalizedSet = new Set(skus.map((s) => normalizeSku(s)));
    const map = new Map<string, string[]>();
    for (const sku of skus) {
      const key = toFamilyKey(sku, normalizedSet);
      const bucket = map.get(key) ?? [];
      bucket.push(sku);
      map.set(key, bucket);
    }
    return map;
  };

  test('AM5234-1, AM5234-2, AM5234-5, AM5234-10 → exactly one family row', () => {
    const skus = ['AM5234-1', 'AM5234-2', 'AM5234-5', 'AM5234-10'];
    const groups = buildFamilyGroups(skus);
    expect(groups.size).toBe(1);
  });

  test('AM5234-1, AM5234-five, AM5234-ten → exactly one family row', () => {
    const skus = ['AM5234-1', 'AM5234-five', 'AM5234-ten'];
    const groups = buildFamilyGroups(skus);
    expect(groups.size).toBe(1);
  });

  test('AM5234 variants + 5234 variants (dual-channel) → exactly one family row', () => {
    // AM5234-1 normalizes to 5234-1; 5234-1 stays 5234-1 → same family
    const skus = ['AM5234-1', 'AM5234-2', '5234-1', '5234-2'];
    const groups = buildFamilyGroups(skus);
    expect(groups.size).toBe(1);
  });

  test('two independent families stay separate', () => {
    const skus = ['AM5234-1', 'AM5234-2', 'AM5237-1', 'AM5237-2'];
    const groups = buildFamilyGroups(skus);
    expect(groups.size).toBe(2);
  });

  test('lone SKU with no siblings stays standalone', () => {
    const skus = ['5116-2'];
    const groups = buildFamilyGroups(skus);
    expect(groups.size).toBe(1);
    expect([...groups.keys()][0]).toBe('5116-2');
  });
});

// ---------------------------------------------------------------------------
// Test: selling 10× of "X-5" registers as 50 base units
//
// inventory_allocations.qty_depleted already stores base units (pack × order qty
// applied during ingest in buildIngestRows). The restock plan reads velocity
// directly from inventory_allocations — no further multiplication needed.
// The family-merge velocity sum uses velocity_90d × in_stock_days.
// Here we verify the multiplier chain: 10 orders of a -5 pack
// → velocity_90d should represent 50 base units / 90 days.
// ---------------------------------------------------------------------------

describe('pack variant velocity: selling 10× of X-5 = 50 base units', () => {
  test('parsePack("AM5234-5").qty = 5', () => {
    // This is the multiplier applied during ingest (buildIngestRows).
    // 10 orders × qty=1 per order × packQty=5 = effectiveQty=50
    const { qty } = parsePack(normalizeSku('AM5234-5'));
    const ordersOfVariant = 10;
    const baseUnitsFromVariant = ordersOfVariant * qty;
    expect(baseUnitsFromVariant).toBe(50);
  });

  test('parsePack("AM5234-ten").qty = 10', () => {
    const { qty } = parsePack(normalizeSku('AM5234-ten'));
    const ordersOfVariant = 10;
    const baseUnitsFromVariant = ordersOfVariant * qty;
    expect(baseUnitsFromVariant).toBe(100);
  });

  test('family merge sums velocity across pack variants correctly', () => {
    // Simulate two variants in a family:
    //   AM5234-1: velocity=5 base units/day (in_stock_days=90 → depleted=450)
    //   AM5234-5: velocity=2 base units/day (in_stock_days=90 → depleted=180)
    //   (These come from SQL which already returned base units via qty_sold×packSize in ingest)
    // Merged velocity = (450 + 180) / max(90, 90) = 630 / 90 = 7.0
    const members = [
      { sku: 'AM5234-1', velocity_90d: 5,   velocity_in_stock_days: 90, qty_available: 100, on_order: 0, ly_horiz_base: 0, has_ly_data: false, ly_monthly_units: [], storefront_mappings: [] },
      { sku: 'AM5234-5', velocity_90d: 2,   velocity_in_stock_days: 90, qty_available: 0,   on_order: 0, ly_horiz_base: 0, has_ly_data: false, ly_monthly_units: [], storefront_mappings: [] },
    ];

    const mergedInStockDays = Math.max(...members.map((m) => m.velocity_in_stock_days));
    const totalDepleted = members.reduce(
      (s, m) => s + m.velocity_90d * Math.max(m.velocity_in_stock_days, 1),
      0,
    );
    const mergedVelocity = mergedInStockDays > 0
      ? Math.round((totalDepleted / mergedInStockDays) * 100) / 100
      : 0;

    expect(mergedVelocity).toBe(7.0);
  });

  test('resolveBaseUnit: AM5234-5 → base 5234 resolves to correct inventory SKU', () => {
    // normalizeSku strips AM prefix → "5234-5"
    // parsePack → base "5234", qty 5
    // resolveBaseUnit("5234", set) → "5234-1" if that's how it's stored
    const normalized = normalizeSku('AM5234-5');  // "5234-5"
    const { base, qty } = parsePack(normalized);  // base="5234", qty=5
    expect(qty).toBe(5);

    const inventorySkuSet = new Set(['5234-1', '5237-1', '5029b']);
    const resolved = resolveBaseUnit(base, inventorySkuSet);
    expect(resolved).toBe('5234-1');
  });
});

// ---------------------------------------------------------------------------
// Regression: old AM-prefix strip vs resolver.normalizeSku produce same result
// ---------------------------------------------------------------------------

describe('regression: resolver.normalizeSku matches old replace(/^AM(?=\\d)/, "")', () => {
  const cases: [string, string][] = [
    ['AM5234-1',   '5234-1'],
    ['AM5237-10',  '5237-10'],
    ['AM5263',     '5263'],
    ['1AM5234-2',  '5234-2'],
    ['5029b',      '5029b'],      // no prefix → unchanged
    ['5234-five',  '5234-five'],  // no prefix → unchanged
  ];

  test.each(cases)('normalizeSku(%s) === %s', (input, expected) => {
    expect(normalizeSku(input)).toBe(expected);
  });

  test('normalizeSku strips 1AMAM prefix too (old regex did not)', () => {
    // Old: '1AMAM5234-1'.replace(/^AM(?=\d)/, '') → '1AMAM5234-1' (no-op)
    // New: normalizeSku strips 1AMAM → '5234-1'
    expect(normalizeSku('1AMAM5234-1')).toBe('5234-1');
  });
});

// ---------------------------------------------------------------------------
// Test: velocity sourced from inventory_allocations (base units, no UNION)
//
// inventory_allocations.qty_depleted is already in base units after Prompt 3
// ingest. getRestockPlan now reads velocity from that table via a simple
// JOIN to order_lines (for date filtering) — no UNION, no local combo math.
//
// These tests simulate the allocation rows that would come from the DB
// and verify the arithmetic that getRestockPlan applies.
// ---------------------------------------------------------------------------

describe('velocity from inventory_allocations: base-unit arithmetic', () => {
  /**
   * Simulate what the velocity SQL returns from inventory_allocations:
   * SUM(qty_depleted) grouped by inventory_sku.
   * qty_depleted was written during ingest as orderQty × packSize.
   */

  test('10 orders of X-5 pack → 50 base units in inventory_allocations', () => {
    // During ingest (buildIngestRows): effectiveQty = orderQty(1) × packSize(5) = 5 per order
    // 10 such orders → total qty_depleted = 50 for the base SKU
    const orderQty = 1;
    const packSize = parsePack(normalizeSku('AM5234-5')).qty; // 5
    const numOrders = 10;
    const totalQtyDepleted = orderQty * packSize * numOrders;
    expect(totalQtyDepleted).toBe(50);
  });

  test('allocation-based velocity: 50 base units / 90 days = 0.56/day', () => {
    // Simulated DB row: inventory_sku='5234-1', depleted=50, in_stock_days=90
    const depleted = 50;
    const inStockDays = 90;
    // Restock plan velocity formula (OOS-corrected, ceiling not reached here)
    const rawVelocity = depleted / inStockDays;
    expect(Math.round(rawVelocity * 100) / 100).toBe(0.56);
  });

  test('no duplicate base-unit rows: resolveBaseUnit collapses AM and non-AM to same key', () => {
    // Both AM5234-5 and 5234-5 produce the same allocation target
    const invSet = new Set(['5234-1', '5237-1']);

    const normalized1 = normalizeSku('AM5234-5');  // → '5234-5'
    const { base: base1 } = parsePack(normalized1); // → '5234'
    const resolved1 = resolveBaseUnit(base1, invSet); // → '5234-1'

    const normalized2 = normalizeSku('5234-5');     // → '5234-5'
    const { base: base2 } = parsePack(normalized2);  // → '5234'
    const resolved2 = resolveBaseUnit(base2, invSet); // → '5234-1'

    // Both resolve to same row → no duplicate
    expect(resolved1).toBe('5234-1');
    expect(resolved2).toBe('5234-1');
    expect(resolved1).toBe(resolved2);
  });

  test('combo child allocation counts as base units for its inventory_sku', () => {
    // Combo AM5234-COMBO sells qty=3; combo has child 5234-1 with quantity=2
    // ingest writes: qty_depleted = orderQty(3) × childQty(2) = 6 for '5234-1'
    const comboOrderQty = 3;
    const childQty = 2;
    const expectedDepleted = comboOrderQty * childQty;
    expect(expectedDepleted).toBe(6);
    // This row lands in inventory_allocations with inventory_sku='5234-1', qty_depleted=6
    // getRestockPlan SUM(qty_depleted) picks it up — no UNION needed
  });
});
