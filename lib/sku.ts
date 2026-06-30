/**
 * Shared SKU family utility.
 *
 * getFamilySku(sku, allSkus?) — the ONE family function in the codebase.
 *
 * Without allSkus: always strips the trailing suffix (used internally where
 * siblings are already known, e.g. physical daily summaries).
 *
 * With allSkus: sibling-aware — strips the suffix ONLY if another SKU in the
 * dataset shares the same base (sibling check). Lone SKUs stay unchanged.
 *
 * Stripping rules (applied in order):
 *  1. Trailing digit suffix:      "AM5234-4"    → "AM5234"
 *  2. Trailing spelled-out number: "AM5234-five" → "AM5234"
 *
 * Hard exclusions (never stripped):
 *  - Letter-suffix SKUs: AM5234B, AM5243B → separate physical products, unchanged.
 *  - Combo/bundle SKUs (two SKUs joined): AM5237-4-AM5273 → unchanged.
 *    Detected by: after stripping the last segment the remainder still contains
 *    a letter-prefixed SKU-like token (e.g. "AM5273").
 *
 * Sibling check (only when allSkus provided):
 *  Strip the suffix to get a candidate base. If at least one OTHER SKU in
 *  allSkus produces the same base via stripping, return the base. Otherwise
 *  return the original SKU unchanged.
 *
 * Parent row label = the family string itself (e.g. "AM5237"), never a variant.
 *
 * Examples (no allSkus — always strip):
 *   "AM5234-4"           → "AM5234"
 *   "AM5234-five"        → "AM5234"
 *   "AM5237-10"          → "AM5237"
 *   "AM5303-1"           → "AM5303"
 *   "15044BY-2"          → "15044BY"
 *   "AM5234B"            → "AM5234B"  (letter suffix — unchanged)
 *   "NS5340"             → "NS5340"   (no suffix — unchanged)
 *   "AM5237-4-AM5273"    → "AM5237-4-AM5273" (combo — unchanged)
 *
 * Examples (with allSkus — sibling check):
 *   "AM5237-10" where ["AM5237-10","AM5237-20"] → "AM5237" (sibling found)
 *   "5116-2"    where ["5116-2"] alone           → "5116-2"  (no sibling)
 *   "AM5234-five" where ["AM5234-five","AM5234-2"] → "AM5234" (sibling)
 */

/** Spelled-out numbers treated as variant suffixes (case-insensitive). */
const WORD_NUMBERS = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty',
  // common pack sizes
  'twenty-four', 'twentyfour', 'thirty', 'thirty-six', 'thirtysix',
  'forty', 'forty-eight', 'fortyeight', 'fifty', 'sixty', 'seventy-two', 'seventytwo',
  'hundred',
]);

/** Regex matching a trailing "-<word>" segment (case-insensitive). */
const WORD_SUFFIX_RE = /-([a-z]+(?:-[a-z]+)?)$/i;

/**
 * Combo SKU detector: a combo looks like "AM5237-4-AM5273" — after stripping
 * a numeric suffix the remainder contains another SKU-like token with letters.
 * We detect this by checking whether the SUFFIX SEGMENT looks like the start
 * of another SKU (contains letters), which would make the last "-token" part
 * of a compound identifier, not a variant number.
 *
 * More precisely: a SKU is a combo if it contains at least two "-" separators
 * AND any segment after the first contains uppercase letters (i.e., looks like
 * a SKU prefix like "AM5273" or "HW").
 */
function isComboSku(sku: string): boolean {
  const parts = sku.split('-');
  if (parts.length < 3) return false;
  // If any segment from index 2 onward contains letters, it's a combo
  return parts.slice(2).some((p) => /[a-zA-Z]/.test(p));
}

/**
 * Attempt to strip ONE trailing suffix from a SKU.
 * Returns the stripped base if stripping is valid, or null if the SKU
 * should remain unchanged (combo, letter-suffix, no suffix).
 */
function tryStripSuffix(sku: string): string | null {
  if (!sku) return null;

  // Guard: combo SKUs stay whole
  if (isComboSku(sku)) return null;

  // Digit suffix: "AM5234-4" → "AM5234"
  const digitMatch = sku.match(/^(.+)-(\d+)$/);
  if (digitMatch) {
    const base = digitMatch[1];
    // Guard: base must not end with a letter-only segment that looks like a combo
    // (extra safety — isComboSku above handles the main case)
    return base;
  }

  // Spelled-out number suffix: "AM5234-five" → "AM5234"
  const wordMatch = sku.match(WORD_SUFFIX_RE);
  if (wordMatch && WORD_NUMBERS.has(wordMatch[1].toLowerCase())) {
    return sku.slice(0, sku.length - wordMatch[0].length);
  }

  return null; // no strippable suffix
}

/**
 * getFamilySku — the single SKU family function.
 *
 * @param sku        The SKU to classify.
 * @param allSkus    Optional: full set/array of SKUs in the current dataset.
 *                   When provided, a sibling check is performed: the suffix is
 *                   stripped only if at least one other SKU shares the same base.
 *                   When absent, the suffix is always stripped (backward-compat).
 */
export function getFamilySku(sku: string, allSkus?: string[] | Set<string>): string {
  if (!sku) return sku;

  const base = tryStripSuffix(sku);
  if (base === null) return sku; // not strippable (combo, letter-suffix, no suffix)

  // No dataset provided — always strip (internal use where siblings are implied).
  if (!allSkus) return base;

  // Sibling check: does any OTHER SKU in the dataset strip to the same base?
  const skuSet = allSkus instanceof Set ? allSkus : new Set(allSkus);
  for (const candidate of skuSet) {
    if (candidate === sku) continue; // skip self
    const candidateBase = tryStripSuffix(candidate);
    // A sibling is any SKU whose stripped base equals our base,
    // OR the candidate itself equals our base (e.g. "AM5237" alongside "AM5237-1").
    if (candidateBase === base || candidate === base) {
      return base; // sibling found → use the family
    }
  }

  // No sibling → return original unchanged
  return sku;
}
