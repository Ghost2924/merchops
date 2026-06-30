import { DailySummary, TrendIndicator, VolatilityEntry } from './data/types';
import { getFamilySku } from './sku';

export function computeTrend(current: number, prior: number): TrendIndicator {
  if (prior === 0) return current > 0 ? 'up' : 'stable';
  const change = (current - prior) / prior;
  if (change > 0.2) return 'up';
  if (change < -0.2) return 'down';
  return 'stable';
}

/**
 * Build per-family velocity entries from the last 14 days of summaries.
 *
 * Grouping: raw storefront SKUs are collapsed by getFamilySku(sku, allStorefrontSkus)
 * (sibling-aware). Each family row:
 *  - velocityCurrent = SUM of variant velocities (recomputed from summed units)
 *  - velocityPrior   = SUM of variant prior velocities (same)
 *  - trend           = recomputed from family-level current vs prior
 *  - daysOfSupply    = family stock / family velocityCurrent (recomputed)
 *
 * Family stock: sum of inventoryMap entries for all variants that belong to
 * the family (using the same getFamilySku grouping).
 */
export function buildVolatilityEntries(
  summaries: DailySummary[], // expects >= 14 days, sorted ascending
  inventoryMap: Map<string, number> = new Map(),
  skuMappingLookup: Map<string, string> = new Map()
): VolatilityEntry[] {
  const sorted = [...summaries].sort((a, b) => a.date.localeCompare(b.date));

  // Use last 14 days: prior = first 7, current = last 7
  const recent = sorted.slice(-14);
  const priorWindow = recent.slice(0, 7);
  const currentWindow = recent.slice(-7);

  // Collect ALL raw storefront SKUs across both windows (needed for sibling check)
  const allRawSkus = new Set<string>();
  [...priorWindow, ...currentWindow].forEach((s) =>
    s.skus.forEach((r) => allRawSkus.add(r.sku))
  );

  // Build family → set of raw variant SKUs mapping
  const familyToVariants = new Map<string, Set<string>>();
  for (const rawSku of allRawSkus) {
    const family = getFamilySku(rawSku, allRawSkus);
    if (!familyToVariants.has(family)) familyToVariants.set(family, new Set());
    familyToVariants.get(family)!.add(rawSku);
  }

  // Sum units per raw SKU across each window
  const currentTotals = new Map<string, number>();
  for (const day of currentWindow) {
    for (const skuRec of day.skus) {
      currentTotals.set(skuRec.sku, (currentTotals.get(skuRec.sku) ?? 0) + skuRec.quantitySold);
    }
  }
  const priorTotals = new Map<string, number>();
  for (const day of priorWindow) {
    for (const skuRec of day.skus) {
      priorTotals.set(skuRec.sku, (priorTotals.get(skuRec.sku) ?? 0) + skuRec.quantitySold);
    }
  }

  // Build family-level stock map:
  // For each variant raw SKU, resolve to physical SKU via mapping, then look up in inventoryMap.
  // Sum all resolved stock values for the family.
  function getFamilyStock(variants: Set<string>): number | undefined {
    let total = 0;
    let found = false;
    for (const rawSku of variants) {
      const physicalSku = inventoryMap.has(rawSku)
        ? rawSku
        : (skuMappingLookup.get(rawSku) ?? skuMappingLookup.get(rawSku.toLowerCase().trim()) ?? rawSku);
      const qty = inventoryMap.get(physicalSku);
      if (qty !== undefined) {
        total += qty;
        found = true;
      }
    }
    return found ? total : undefined;
  }

  const entries: VolatilityEntry[] = [];

  for (const [family, variants] of familyToVariants) {
    // Sum current and prior totals across all variants
    let currentTotal = 0;
    let priorTotal = 0;
    for (const rawSku of variants) {
      currentTotal += currentTotals.get(rawSku) ?? 0;
      priorTotal += priorTotals.get(rawSku) ?? 0;
    }

    // Velocity = total units / 7 days
    const velocityCurrent = currentWindow.length > 0 ? currentTotal / 7 : 0;
    const velocityPrior = priorWindow.length > 0 ? priorTotal / 7 : 0;

    // Days of supply: family stock / family velocity (recomputed)
    const qtyAvailable = getFamilyStock(variants);
    let daysOfSupply: number | null = null;
    if (qtyAvailable !== undefined) {
      daysOfSupply =
        velocityCurrent > 0
          ? Math.round(qtyAvailable / velocityCurrent)
          : null; // infinite / unknown if velocity is 0
    }

    entries.push({
      sku: family,
      velocityCurrent: Math.round(velocityCurrent * 100) / 100,
      velocityPrior: Math.round(velocityPrior * 100) / 100,
      trend: computeTrend(velocityCurrent, velocityPrior),
      daysOfSupply,
    });
  }

  return entries.sort((a, b) => b.velocityCurrent - a.velocityCurrent);
}
