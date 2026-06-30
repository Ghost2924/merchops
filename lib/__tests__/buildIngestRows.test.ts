/**
 * buildIngestRows integration tests.
 *
 * Teapplix data model:
 *   inventory_products (type 0) = physical warehouse SKUs, e.g. "5003MCC-1"
 *   combo_products     (type 1) = virtual bundles/packs, e.g. "5003MCC-4"
 *   combo_components            = recipe: "5003MCC-4" → 4 × "5003MCC-1"
 *
 * Proves:
 *  1. "5003MCC-4" (combo) + combo_components(qty=4, child="5003MCC-1")
 *     → depletes 4 × "5003MCC-1" (combo_explode)
 *  2. "AM5227-2-AM5228" (combo) → 1 × AM5227 + 2 × AM5228 depleted (combo_explode)
 *  3. SKU not in sku_mappings → unmapped (no silent auto-map to catalog)
 */

import { buildIngestRows, RawOrderItem, ComboComponentRow } from '../db/queries';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<RawOrderItem> = {}): RawOrderItem {
  return {
    marketplace_sku: 'RAW-ASIN',
    order_id: 'ORD-001',
    order_date: '2026-06-04',
    marketplace: 'amazon',
    qty: 1,
    total_price: 10.0,
    line_number: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Pack combo SKU — "5003MCC-4" depletes 4 × "5003MCC-1"
//
// Real data model: "5003MCC-4" is item type 1 (combo_products).
// combo_components: 5003MCC-4 → child: 5003MCC-1, qty: 4.
// Selling 1 × "5003MCC-4" → depletes 4 × "5003MCC-1".
// ---------------------------------------------------------------------------

describe('buildIngestRows — pack combo "5003MCC-4" depletes 4 × "5003MCC-1"', () => {
  const mappingLookup = new Map([['B0ASIN001', '5003MCC-4']]);
  const inventorySkuSet = new Set(['5003MCC-1']);
  const comboSkuSet = new Set(['5003MCC-4']);
  const comboComponents: ComboComponentRow[] = [
    { combo_sku: '5003MCC-4', child_inventory_sku: '5003MCC-1', quantity: 4, sequence: 1 },
  ];
  const comboLookup = new Map([['5003MCC-4', comboComponents]]);

  const items = [makeItem({ marketplace_sku: 'B0ASIN001', qty: 1 })];
  const result = buildIngestRows(items, mappingLookup, comboLookup, inventorySkuSet, comboSkuSet);

  test('no unmapped SKUs', () => {
    expect(result.unmappedSkus).toHaveLength(0);
  });

  test('no mapping errors', () => {
    expect(result.mappingErrors).toHaveLength(0);
  });

  test('order line: resolved_teapplix_sku = "5003MCC-4"', () => {
    expect(result.orderLineRows[0].resolved_teapplix_sku).toBe('5003MCC-4');
  });

  test('order line: product_type = "combo"', () => {
    expect(result.orderLineRows[0].resolved_product_type).toBe('combo');
  });

  test('1 allocation row', () => {
    expect(result.allocationRows).toHaveLength(1);
  });

  test('allocation: inventory_sku = "5003MCC-1"', () => {
    expect(result.allocationRows[0].inventory_sku).toBe('5003MCC-1');
  });

  test('allocation: qty_depleted = 1 order × 4 child.qty = 4', () => {
    expect(result.allocationRows[0].qty_depleted).toBe(4);
  });

  test('allocation: type = "combo_explode"', () => {
    expect(result.allocationRows[0].allocation_type).toBe('combo_explode');
  });
});

// Variant: 3 orders × combo(child qty=4) = 12 units depleted
describe('buildIngestRows — pack combo "5003MCC-4", order qty=3', () => {
  const mappingLookup = new Map([['B0ASIN001', '5003MCC-4']]);
  const inventorySkuSet = new Set(['5003MCC-1']);
  const comboSkuSet = new Set(['5003MCC-4']);
  const comboComponents: ComboComponentRow[] = [
    { combo_sku: '5003MCC-4', child_inventory_sku: '5003MCC-1', quantity: 4, sequence: 1 },
  ];
  const comboLookup = new Map([['5003MCC-4', comboComponents]]);

  const items = [makeItem({ marketplace_sku: 'B0ASIN001', qty: 3 })];
  const result = buildIngestRows(items, mappingLookup, comboLookup, inventorySkuSet, comboSkuSet);

  test('qty_depleted = 3 order × 4 child.qty = 12', () => {
    expect(result.allocationRows[0].qty_depleted).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Combo SKU — "AM5227-2-AM5228" depletes 1×AM5227 + 2×AM5228
// ---------------------------------------------------------------------------

describe('buildIngestRows — combo SKU "AM5227-2-AM5228"', () => {
  const mappingLookup = new Map([['B0ASIN002', 'AM5227-2-AM5228']]);
  const inventorySkuSet = new Set(['AM5227', 'AM5228']);
  const comboSkuSet = new Set(['AM5227-2-AM5228']);

  // combo_components: 1×AM5227 + 2×AM5228 per combo sold
  const comboComponents: ComboComponentRow[] = [
    { combo_sku: 'AM5227-2-AM5228', child_inventory_sku: 'AM5227', quantity: 1, sequence: 1 },
    { combo_sku: 'AM5227-2-AM5228', child_inventory_sku: 'AM5228', quantity: 2, sequence: 2 },
  ];
  const comboLookup = new Map([['AM5227-2-AM5228', comboComponents]]);

  const items = [makeItem({ marketplace_sku: 'B0ASIN002', qty: 1 })];

  const result = buildIngestRows(items, mappingLookup, comboLookup, inventorySkuSet, comboSkuSet);

  test('no unmapped SKUs', () => {
    expect(result.unmappedSkus).toHaveLength(0);
  });

  test('no mapping errors', () => {
    expect(result.mappingErrors).toHaveLength(0);
  });

  test('order line: resolved_teapplix_sku = "AM5227-2-AM5228"', () => {
    expect(result.orderLineRows[0].resolved_teapplix_sku).toBe('AM5227-2-AM5228');
  });

  test('order line: product_type = "combo"', () => {
    expect(result.orderLineRows[0].resolved_product_type).toBe('combo');
  });

  test('2 allocation rows (one per child)', () => {
    expect(result.allocationRows).toHaveLength(2);
  });

  test('AM5227 allocation: qty_depleted = 1', () => {
    const row = result.allocationRows.find((r) => r.inventory_sku === 'AM5227');
    expect(row).toBeDefined();
    expect(row!.qty_depleted).toBe(1);
    expect(row!.allocation_type).toBe('combo_explode');
  });

  test('AM5228 allocation: qty_depleted = 2', () => {
    const row = result.allocationRows.find((r) => r.inventory_sku === 'AM5228');
    expect(row).toBeDefined();
    expect(row!.qty_depleted).toBe(2);
    expect(row!.allocation_type).toBe('combo_explode');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: No silent auto-map — SKU not in sku_mappings → unmapped
// ---------------------------------------------------------------------------

describe('buildIngestRows — no silent auto-map to catalog', () => {
  // SKU exists in inventory catalog but is NOT in sku_mappings
  const mappingLookup = new Map<string, string>(); // empty
  const inventorySkuSet = new Set(['5003MCC-1']); // SKU in catalog
  const comboSkuSet = new Set<string>();
  const comboLookup = new Map<string, ComboComponentRow[]>();

  // Raw storefront SKU that matches catalog directly (old auto-map would have resolved it)
  const items = [makeItem({ marketplace_sku: '5003MCC-1' })];

  const result = buildIngestRows(items, mappingLookup, comboLookup, inventorySkuSet, comboSkuSet);

  test('SKU goes to unmapped_skus, NOT auto-resolved', () => {
    expect(result.unmappedSkus).toContain('5003MCC-1');
  });

  test('no allocations created', () => {
    expect(result.allocationRows).toHaveLength(0);
  });

  test('order line mapping_status = "unmapped"', () => {
    expect(result.orderLineRows[0].mapping_status).toBe('unmapped');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Mapping points to missing SKU → mapping_error
// ---------------------------------------------------------------------------

describe('buildIngestRows — mapping target missing from catalog', () => {
  const mappingLookup = new Map([['B0ASIN003', 'GHOST-SKU']]);
  const inventorySkuSet = new Set<string>(); // GHOST-SKU not here
  const comboSkuSet = new Set<string>();
  const comboLookup = new Map<string, ComboComponentRow[]>();

  const items = [makeItem({ marketplace_sku: 'B0ASIN003' })];
  const result = buildIngestRows(items, mappingLookup, comboLookup, inventorySkuSet, comboSkuSet);

  test('goes to mappingErrors', () => {
    expect(result.mappingErrors).toContain('GHOST-SKU');
  });

  test('no allocations', () => {
    expect(result.allocationRows).toHaveLength(0);
  });

  test('order line mapping_status = "mapping_error"', () => {
    expect(result.orderLineRows[0].mapping_status).toBe('mapping_error');
  });
});
