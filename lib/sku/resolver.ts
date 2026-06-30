/**
 * lib/sku/resolver.ts
 *
 * THE ONLY place SKU normalization, pack-size parsing, and combo decomposition
 * may live.  Pure functions, no DB calls, no side effects.
 *
 * Consumers: import from here; never re-implement these rules elsewhere.
 */

// ---------------------------------------------------------------------------
// WORD_PACK_SIZES — the single authoritative copy in the codebase
// ---------------------------------------------------------------------------

export const WORD_PACK_SIZES: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
};

// ---------------------------------------------------------------------------
// normalizeSku
// ---------------------------------------------------------------------------

/**
 * Clean a raw SKU string into a canonical form suitable for lookup.
 *
 * Rules applied in order:
 *  1. Trim surrounding whitespace.
 *  2. Strip surrounding quotes (single, double, triple).
 *  3. Strip a leading Excel-export apostrophe  (')
 *  4. Remove embedded newlines / carriage returns.
 *  5. Strip a leading "AM" / "1AM" / "1AMAM" prefix.
 *  6. Strip a trailing "-LA" or "-par" suffix (case-insensitive).
 *  7. Collapse internal whitespace runs to a single space.
 *
 * Comparisons against the result should be case-insensitive.
 */
export function normalizeSku(raw: string): string {
  if (!raw) return '';

  let s = raw.trim();

  // Strip triple-double-quotes first ("""SKU""")
  s = s.replace(/^"""+|"""+$/g, '');

  // Strip surrounding single or double quotes
  s = s.replace(/^['"]|['"]$/g, '');

  // Strip leading Excel apostrophe
  if (s.startsWith("'")) s = s.slice(1);

  // Remove embedded newlines / carriage returns
  s = s.replace(/[\r\n]+/g, '');

  // Strip leading "1AMAM" / "1AM" / "AM" prefix (case-insensitive, longest first)
  s = s.replace(/^1AMAM/i, '').replace(/^1AM/i, '').replace(/^AM/i, '');

  // Strip trailing "-LA" or "-par" (case-insensitive)
  s = s.replace(/-(LA|par)$/i, '');

  // Collapse internal whitespace
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

// ---------------------------------------------------------------------------
// parsePack
// ---------------------------------------------------------------------------

export interface PackResult {
  base: string;
  qty: number;
}

/**
 * Split a (already-normalized) SKU into its base and pack quantity.
 *
 * Rules:
 *  - If SKU ends in "-<digits>PK" (case-insensitive) → qty = that number, base = the rest.
 *  - If SKU ends in "-<digits>" → qty = that number, base = the rest.
 *  - If SKU ends in "-<WORD_PACK_SIZES key>" (case-insensitive) → qty = mapped
 *    number, base = the rest.
 *  - Otherwise → qty = 1, base = sku.
 */
export function parsePack(sku: string): PackResult {
  if (!sku) return { base: sku, qty: 1 };

  // "<digits>PK" suffix (e.g. NS5330-5PK → base NS5330, qty 5)
  const pkMatch = sku.match(/^(.+)-(\d+)PK$/i);
  if (pkMatch) {
    return { base: pkMatch[1], qty: parseInt(pkMatch[2], 10) };
  }

  // Digit suffix
  const digitMatch = sku.match(/^(.+)-(\d+)$/);
  if (digitMatch) {
    return { base: digitMatch[1], qty: parseInt(digitMatch[2], 10) };
  }

  // Word suffix
  const wordMatch = sku.match(/^(.+)-([a-z]+)$/i);
  if (wordMatch) {
    const word = wordMatch[2].toLowerCase();
    if (word in WORD_PACK_SIZES) {
      return { base: wordMatch[1], qty: WORD_PACK_SIZES[word] };
    }
  }

  return { base: sku, qty: 1 };
}

// ---------------------------------------------------------------------------
// resolveBaseUnit
// ---------------------------------------------------------------------------

/**
 * Find the Item-Type-0 SKU that corresponds to `base`.
 *
 * Accepts a match if EITHER:
 *   • `base` exists in type0set (case-insensitive), OR
 *   • `base + "-1"` exists in type0set (case-insensitive).
 *
 * Returns the canonical form (as stored in type0set) or null.
 */
export function resolveBaseUnit(
  base: string,
  type0set: Set<string>,
): string | null {
  if (!base) return null;

  const lower = base.toLowerCase();
  const lower1 = lower + '-1';

  for (const entry of type0set) {
    const el = entry.toLowerCase();
    if (el === lower || el === lower1) return entry;
  }

  return null;
}

// ---------------------------------------------------------------------------
// decomposeCombo
// ---------------------------------------------------------------------------

export interface ComboChild {
  childBaseUnit: string;
  qty: number;
}

/**
 * Decompose a combo or pack SKU into its constituent base units.
 *
 * Patterns (applied to the already-normalized sku):
 *
 *  1. Simple pack  "BASE-n"    → [{ resolveBaseUnit(BASE), n }]
 *     (n is a digit run or WORD_PACK_SIZES key)
 *
 *  2. Cross combo  "A-n-B"     → [{ resolveBaseUnit(A), 1 },
 *                                  { resolveBaseUnit(B), n }]
 *     where n is a digit run or WORD_PACK_SIZES key and B contains letters
 *     (detected as a second SKU token).
 *
 * Returns null when:
 *  - No pack suffix / cross-combo pattern is found, OR
 *  - Any child fails to resolve in type0set.
 *
 * NEVER guesses — returns null to route to review queue.
 */
export function decomposeCombo(
  comboSku: string,
  type0set: Set<string>,
): ComboChild[] | null {
  if (!comboSku) return null;

  // ── Cross-combo detection: "A-n-B" ─────────────────────────────────────
  // Segment on "-". Pattern: at least 3 segments, the middle one is a number
  // (digit or word), and the last segment contains letters (i.e. looks like a
  // SKU token, not a color/variant suffix).
  const segments = comboSku.split('-');

  if (segments.length >= 3) {
    // Try last segment as "B", second-to-last as "n"
    const lastSeg = segments[segments.length - 1];
    const nSeg = segments[segments.length - 2];

    const isLetterToken = (s: string) => /[a-zA-Z]/.test(s) && /\d/.test(s);

    // n must be digit-only or a word-pack key
    const nDigit = /^\d+$/.test(nSeg);
    const nWord = nSeg.toLowerCase() in WORD_PACK_SIZES;

    // B must look like a SKU (has both letters and digits)
    if ((nDigit || nWord) && isLetterToken(lastSeg)) {
      const aBase = segments.slice(0, segments.length - 2).join('-');
      const bBase = lastSeg;
      const qty = nDigit
        ? parseInt(nSeg, 10)
        : WORD_PACK_SIZES[nSeg.toLowerCase()];

      const resolvedA = resolveBaseUnit(aBase, type0set);
      const resolvedB = resolveBaseUnit(bBase, type0set);

      if (resolvedA === null || resolvedB === null) return null;

      return [
        { childBaseUnit: resolvedA, qty: 1 },
        { childBaseUnit: resolvedB, qty },
      ];
    }
  }

  // ── Simple pack: "BASE-n" ───────────────────────────────────────────────
  const { base, qty } = parsePack(comboSku);

  if (qty === 1) {
    // qty === 1: could be a single-unit alias (e.g. AM5233B-1 → 1 × 5233B-1).
    // Attempt base resolution; return a 1-child result only if base resolves.
    // If base is absent from catalog, return null (not a guessable decomposition).
    const resolvedAlias = resolveBaseUnit(base, type0set);
    if (resolvedAlias === null) return null;
    return [{ childBaseUnit: resolvedAlias, qty: 1 }];
  }

  const resolved = resolveBaseUnit(base, type0set);
  if (resolved === null) return null;

  return [{ childBaseUnit: resolved, qty }];
}
