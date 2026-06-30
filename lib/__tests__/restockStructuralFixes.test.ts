/**
 * Unit tests for the three structural fixes to the restock planner.
 *
 * Fix 1 — Open PO tracking: on_order from PO table reduces order_now.
 * Fix 2 — Per-SKU lead times: per-SKU value wins over global default.
 * Fix 3 — MOQ / case-pack: order_moq rounds order_now UP to case pack, never below moq.
 *
 * All tests use pure arithmetic extracted from getRestockPlan — no DB required.
 */

// ---------------------------------------------------------------------------
// Helpers — mirrors exact logic in getRestockPlan
// ---------------------------------------------------------------------------

const LEAD_TIME_DAYS: Record<string, number> = {
  thailand: 75,
  china: 60,
  default: 60,
};
const COVERAGE_DAYS = 90;

/** Resolve lead time exactly as getRestockPlan does post-Fix-2. */
function resolveLeadTime(
  skuLeadTimeDays: number | null,
  supplierOrigin: string | null
): { leadTime: number; usingDefault: boolean } {
  const skuLeadTime = skuLeadTimeDays ?? null;
  const originLeadTime =
    supplierOrigin != null
      ? (LEAD_TIME_DAYS[supplierOrigin.toLowerCase()] ?? null)
      : null;
  const usingDefault = skuLeadTime === null && originLeadTime === null;
  const leadTime = skuLeadTime ?? originLeadTime ?? LEAD_TIME_DAYS['default'];
  return { leadTime, usingDefault };
}

/** Compute order_now exactly as getRestockPlan does. */
function computeOrderNow(params: {
  forecast: number;
  safetyStock: number;
  onHand: number;
  onOrder: number;
  velocity: number;
  horizon: number;
}): number {
  const { forecast, safetyStock, onHand, onOrder, velocity, horizon } = params;
  const target = forecast + safetyStock;
  const orderCap = velocity > 0 ? Math.ceil(velocity * horizon * 2) : 0;
  const daysOfCover = velocity > 0 ? (onHand + onOrder) / velocity : null;
  let orderNow = Math.max(0, Math.ceil(target - onHand - onOrder));
  orderNow = Math.min(orderNow, orderCap);
  if (daysOfCover !== null && daysOfCover > horizon) orderNow = 0;
  return orderNow;
}

/** Compute order_moq exactly as getRestockPlan does post-Fix-3. */
function computeOrderMoq(orderNow: number, casePack: number, moq: number): number {
  if (orderNow === 0) return 0;
  const pack = casePack > 1 ? casePack : 1;
  const roundedUp = Math.ceil(orderNow / pack) * pack;
  return Math.max(roundedUp, moq);
}

// ---------------------------------------------------------------------------
// Fix 1: Open PO reduces order_now
// ---------------------------------------------------------------------------

describe('Fix 1 — Open PO tracking: on_order reduces order_now', () => {
  const velocity = 2;          // units/day
  const leadTime = 60;
  const horizon  = leadTime + COVERAGE_DAYS; // 150
  const safetyDays = Math.round(leadTime * 0.25); // 15
  const safetyStock = velocity * safetyDays;      // 30
  const forecast = velocity * horizon;             // 300
  const onHand   = 50;

  test('on_order = 0 (no PO): order_now = ceil(forecast + safety - onHand)', () => {
    const orderNow = computeOrderNow({ forecast, safetyStock, onHand, onOrder: 0, velocity, horizon });
    // target = 300 + 30 = 330; order_now = ceil(330 - 50 - 0) = 280
    expect(orderNow).toBe(280);
  });

  test('inbound PO of 100 reduces order_now by 100', () => {
    const onOrder  = 100;
    const orderNow = computeOrderNow({ forecast, safetyStock, onHand, onOrder, velocity, horizon });
    // order_now = ceil(330 - 50 - 100) = 180
    expect(orderNow).toBe(180);
  });

  test('inbound PO covers the entire deficit → order_now = 0', () => {
    const onOrder  = 300; // more than enough
    const orderNow = computeOrderNow({ forecast, safetyStock, onHand, onOrder, velocity, horizon });
    expect(orderNow).toBe(0);
  });

  test('on_order also reduces days_of_cover (overstocked guard fires)', () => {
    // onHand=400, onOrder=100 → daysOfCover = (400+100)/2 = 250 > horizon(150)
    const orderNow = computeOrderNow({ forecast, safetyStock, onHand: 400, onOrder: 100, velocity, horizon });
    expect(orderNow).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: Per-SKU lead times
// ---------------------------------------------------------------------------

describe('Fix 2 — Per-SKU lead times', () => {
  test('explicit per-SKU lead_time_days wins over everything', () => {
    const { leadTime, usingDefault } = resolveLeadTime(45, 'china');
    expect(leadTime).toBe(45);
    expect(usingDefault).toBe(false);
  });

  test('null per-SKU falls back to origin-based constant (thailand → 75)', () => {
    const { leadTime, usingDefault } = resolveLeadTime(null, 'thailand');
    expect(leadTime).toBe(75);
    expect(usingDefault).toBe(false);
  });

  test('null per-SKU falls back to origin-based constant (china → 60)', () => {
    const { leadTime, usingDefault } = resolveLeadTime(null, 'china');
    expect(leadTime).toBe(60);
    expect(usingDefault).toBe(false);
  });

  test('null per-SKU + null origin → global default (60), flagged', () => {
    const { leadTime, usingDefault } = resolveLeadTime(null, null);
    expect(leadTime).toBe(60);
    expect(usingDefault).toBe(true);
  });

  test('unknown origin string → global default, flagged', () => {
    const { leadTime, usingDefault } = resolveLeadTime(null, 'vietnam');
    expect(leadTime).toBe(60);
    expect(usingDefault).toBe(true);
  });

  test('longer lead time (thailand 75d) increases horizon and reorder_now', () => {
    const velocity = 2;
    const { leadTime } = resolveLeadTime(null, 'thailand');
    const horizon  = leadTime + COVERAGE_DAYS;      // 75 + 90 = 165
    const safetyDays = Math.round(leadTime * 0.25); // 19
    const forecast = velocity * horizon;             // 330
    const safetyStock = velocity * safetyDays;       // 38
    const orderNow = computeOrderNow({ forecast, safetyStock, onHand: 50, onOrder: 0, velocity, horizon });
    // target = 330 + 38 = 368; order_now = 368 - 50 = 318
    expect(orderNow).toBe(318);
    // China (default) same velocity would have order_now = 280 (see Fix 1 test)
    expect(orderNow).toBeGreaterThan(280);
  });

  test('usingDefault flag drives confidence_flag "default_lead_time"', () => {
    const { usingDefault } = resolveLeadTime(null, null);
    const flags: string[] = [];
    if (usingDefault) flags.push('default_lead_time');
    expect(flags).toContain('default_lead_time');
  });

  test('explicit lead time does NOT set "default_lead_time" flag', () => {
    const { usingDefault } = resolveLeadTime(45, null);
    const flags: string[] = [];
    if (usingDefault) flags.push('default_lead_time');
    expect(flags).not.toContain('default_lead_time');
  });
});

// ---------------------------------------------------------------------------
// Fix 3: MOQ / case-pack rounding
// ---------------------------------------------------------------------------

describe('Fix 3 — MOQ / case-pack: order_moq rounds up, never below moq', () => {
  test('no case pack (1), no moq: order_moq === order_now', () => {
    expect(computeOrderMoq(100, 1, 0)).toBe(100);
  });

  test('case_pack=12, order_now=100 → rounds up to 108 (9 × 12)', () => {
    expect(computeOrderMoq(100, 12, 0)).toBe(108);
  });

  test('case_pack=12, order_now=96 → stays at 96 (exact multiple)', () => {
    expect(computeOrderMoq(96, 12, 0)).toBe(96);
  });

  test('case_pack=12, order_now=1 → rounds up to 12', () => {
    expect(computeOrderMoq(1, 12, 0)).toBe(12);
  });

  test('moq=50, order_now=30, case_pack=1 → order_moq=50 (moq floor)', () => {
    expect(computeOrderMoq(30, 1, 50)).toBe(50);
  });

  test('moq=50, order_now=60, case_pack=1 → order_moq=60 (order_now wins)', () => {
    expect(computeOrderMoq(60, 1, 50)).toBe(60);
  });

  test('moq=200, case_pack=12, order_now=100 → roundedUp=108, moq=200 → 200', () => {
    expect(computeOrderMoq(100, 12, 200)).toBe(200);
  });

  test('moq=200, case_pack=12, order_now=204 → roundedUp=204 (exact), moq=200 → 204', () => {
    // 204 / 12 = 17 exactly
    expect(computeOrderMoq(204, 12, 200)).toBe(204);
  });

  test('order_now=0 → order_moq=0 regardless of case_pack/moq', () => {
    expect(computeOrderMoq(0, 12, 500)).toBe(0);
  });

  test('order_now unchanged by order_moq computation', () => {
    // Core demand math must not change
    const orderNow = computeOrderNow({
      forecast: 300, safetyStock: 30, onHand: 50, onOrder: 0,
      velocity: 2, horizon: 150,
    });
    const orderMoq = computeOrderMoq(orderNow, 12, 0);
    // order_now = 280, order_moq = ceil(280/12)*12 = ceil(23.33)*12 = 24*12 = 288
    expect(orderNow).toBe(280);
    expect(orderMoq).toBe(288);
    expect(orderMoq).toBeGreaterThanOrEqual(orderNow);
  });
});

// ---------------------------------------------------------------------------
// Confidence flags
// ---------------------------------------------------------------------------

describe('confidence flags — surface only, no math change', () => {
  function buildFlags(opts: {
    hasLyData: boolean;
    snapMature: boolean;
    usingDefaultLeadTime: boolean;
  }): string[] {
    const flags: string[] = [];
    if (!opts.hasLyData) flags.push('velocity_only_no_ly');
    if (!opts.snapMature) flags.push('immature_snapshots');
    if (opts.usingDefaultLeadTime) flags.push('default_lead_time');
    return flags;
  }

  test('no LY data → velocity_only_no_ly', () => {
    const flags = buildFlags({ hasLyData: false, snapMature: true, usingDefaultLeadTime: false });
    expect(flags).toContain('velocity_only_no_ly');
    expect(flags).not.toContain('immature_snapshots');
    expect(flags).not.toContain('default_lead_time');
  });

  test('immature snapshots → immature_snapshots', () => {
    const flags = buildFlags({ hasLyData: true, snapMature: false, usingDefaultLeadTime: false });
    expect(flags).toContain('immature_snapshots');
  });

  test('default lead time → default_lead_time', () => {
    const flags = buildFlags({ hasLyData: true, snapMature: true, usingDefaultLeadTime: true });
    expect(flags).toContain('default_lead_time');
  });

  test('fresh install: no LY + immature snaps + default lead time → all three flags', () => {
    const flags = buildFlags({ hasLyData: false, snapMature: false, usingDefaultLeadTime: true });
    expect(flags).toHaveLength(3);
    expect(flags).toContain('velocity_only_no_ly');
    expect(flags).toContain('immature_snapshots');
    expect(flags).toContain('default_lead_time');
  });

  test('fully mature data → no flags', () => {
    const flags = buildFlags({ hasLyData: true, snapMature: true, usingDefaultLeadTime: false });
    expect(flags).toHaveLength(0);
  });
});
