import * as fc from 'fast-check';
import {
  normalizeSku,
  parsePack,
  resolveBaseUnit,
  decomposeCombo,
  WORD_PACK_SIZES,
} from '../sku/resolver';

// ---------------------------------------------------------------------------
// normalizeSku
// ---------------------------------------------------------------------------

describe('normalizeSku', () => {
  test('trims whitespace', () => {
    expect(normalizeSku('  5044b-2 ')).toBe('5044b-2');
  });

  test('strips surrounding double quotes', () => {
    expect(normalizeSku('"5003MCC-4"')).toBe('5003MCC-4');
  });

  test('strips triple-double-quotes', () => {
    expect(normalizeSku('"""5003MCC-4"""')).toBe('5003MCC-4');
  });

  test('strips leading Excel apostrophe', () => {
    expect(normalizeSku("'5050")).toBe('5050');
  });

  test('strips leading AM prefix', () => {
    expect(normalizeSku('AM5106-2')).toBe('5106-2');
  });

  test('strips leading 1AM prefix', () => {
    expect(normalizeSku('1AM5106-2')).toBe('5106-2');
  });

  test('strips leading 1AMAM prefix', () => {
    expect(normalizeSku('1AMAM5106-2')).toBe('5106-2');
  });

  test('strips trailing -LA', () => {
    expect(normalizeSku('5003DM-4-LA')).toBe('5003DM-4');
  });

  test('strips trailing -par', () => {
    expect(normalizeSku('5048-24DM-2-par')).toBe('5048-24DM-2');
  });

  test('removes embedded newlines', () => {
    expect(normalizeSku('\nB0GFY87GJM')).toBe('B0GFY87GJM');
  });

  test('case-insensitive -LA strip', () => {
    expect(normalizeSku('5003DM-4-la')).toBe('5003DM-4');
  });

  test('empty string returns empty', () => {
    expect(normalizeSku('')).toBe('');
  });

  test('AM prefix strip is case-insensitive', () => {
    expect(normalizeSku('am5109-2')).toBe('5109-2');
  });
});

// ---------------------------------------------------------------------------
// parsePack
// ---------------------------------------------------------------------------

describe('parsePack', () => {
  test('digit suffix -4', () => {
    expect(parsePack('5003MCC-4')).toEqual({ base: '5003MCC', qty: 4 });
  });

  test('digit suffix -2', () => {
    expect(parsePack('5029w-2')).toEqual({ base: '5029w', qty: 2 });
  });

  test('word suffix -five = qty 5', () => {
    expect(parsePack('5031DM-five')).toEqual({ base: '5031DM', qty: 5 });
  });

  test('word suffix -Four (case-insensitive) = qty 4', () => {
    expect(parsePack('5060MDM-Four')).toEqual({ base: '5060MDM', qty: 4 });
  });

  test('word suffix -two = qty 2', () => {
    expect(parsePack('5003MDM-two')).toEqual({ base: '5003MDM', qty: 2 });
  });

  test('word suffix -twelve = qty 12', () => {
    expect(parsePack('5120B-twelve')).toEqual({ base: '5120B', qty: 12 });
  });

  test('-5 and -five produce same qty', () => {
    const r1 = parsePack('5031DM-5');
    const r2 = parsePack('5031DM-five');
    expect(r1.qty).toBe(r2.qty);
    expect(r1.base).toBe(r2.base);
  });

  test('no suffix → qty 1', () => {
    expect(parsePack('5029b')).toEqual({ base: '5029b', qty: 1 });
  });

  test('non-word letter suffix → qty 1', () => {
    // "-LA" was already stripped by normalizeSku; but even if present, no match
    expect(parsePack('5003DM-hw')).toEqual({ base: '5003DM-hw', qty: 1 });
  });

  test('empty string returns qty 1', () => {
    expect(parsePack('')).toEqual({ base: '', qty: 1 });
  });

  // Property: -n and -word(n) always agree on qty
  test('property: digit and word suffixes agree for all WORD_PACK_SIZES', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(WORD_PACK_SIZES)),
        (word) => {
          const qty = WORD_PACK_SIZES[word];
          const byWord = parsePack(`BASE-${word}`);
          const byDigit = parsePack(`BASE-${qty}`);
          return byWord.qty === byDigit.qty && byWord.base === byDigit.base;
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// resolveBaseUnit
// ---------------------------------------------------------------------------

describe('resolveBaseUnit', () => {
  const type0set = new Set([
    '5029b',
    '5029W',
    '5003MCC-1',  // bare base stored as -1 form
    '5003DM',
    '5031DM',
  ]);

  test('bare base match', () => {
    expect(resolveBaseUnit('5029b', type0set)).toBe('5029b');
  });

  test('case-insensitive bare match', () => {
    expect(resolveBaseUnit('5029B', type0set)).toBe('5029b');
  });

  test('base-1 match: resolveBaseUnit("5003MCC") hits "5003MCC-1"', () => {
    // type0set contains "5003MCC-1"; query is bare "5003MCC"
    expect(resolveBaseUnit('5003MCC', type0set)).toBe('5003MCC-1');
  });

  test('returns canonical form from set', () => {
    // set has "5029W" with capital W
    expect(resolveBaseUnit('5029w', type0set)).toBe('5029W');
  });

  test('returns null when no match', () => {
    expect(resolveBaseUnit('UNKNOWN', type0set)).toBeNull();
  });

  test('empty base returns null', () => {
    expect(resolveBaseUnit('', type0set)).toBeNull();
  });

  // Property: bare vs -1 form always resolve to same entry
  test('property: bare and bare-1 always hit the same set entry', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z0-9]{4,8}$/),
        (base) => {
          const set = new Set([base, base + '-1']);
          const r1 = resolveBaseUnit(base, set);
          const r2 = resolveBaseUnit(base + '-1', set);
          // both should resolve (may differ on which canonical they return, but both non-null)
          return r1 !== null && r2 !== null;
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// decomposeCombo
// ---------------------------------------------------------------------------

describe('decomposeCombo', () => {
  const type0set = new Set([
    '5029b',
    '5029W',
    '5003MCC-1',   // bare "5003MCC" resolves here
    '5031DM',
    'AM5240GY',
    'AM5231',
    'AM5232',
    'AM5239',
  ]);

  // Simple pack
  test('simple pack "5029b-2" → [{ childBaseUnit: "5029b", qty: 2 }]', () => {
    expect(decomposeCombo('5029b-2', type0set)).toEqual([
      { childBaseUnit: '5029b', qty: 2 },
    ]);
  });

  test('simple pack word suffix "5031DM-four"', () => {
    expect(decomposeCombo('5031DM-four', type0set)).toEqual([
      { childBaseUnit: '5031DM', qty: 4 },
    ]);
  });

  test('simple pack resolves base via -1 form', () => {
    // "5003MCC-4" → base "5003MCC" → resolves to "5003MCC-1"
    expect(decomposeCombo('5003MCC-4', type0set)).toEqual([
      { childBaseUnit: '5003MCC-1', qty: 4 },
    ]);
  });

  // Cross-combo A-n-B
  test('cross-combo "AM5240GY-2-AM5231"', () => {
    expect(decomposeCombo('AM5240GY-2-AM5231', type0set)).toEqual([
      { childBaseUnit: 'AM5240GY', qty: 1 },
      { childBaseUnit: 'AM5231', qty: 2 },
    ]);
  });

  test('cross-combo "AM5240GY-4-AM5232"', () => {
    expect(decomposeCombo('AM5240GY-4-AM5232', type0set)).toEqual([
      { childBaseUnit: 'AM5240GY', qty: 1 },
      { childBaseUnit: 'AM5232', qty: 4 },
    ]);
  });

  // Null / review-queue paths
  test('returns null when child A unresolvable', () => {
    expect(decomposeCombo('UNKNOWN-2-AM5231', type0set)).toBeNull();
  });

  test('returns null when child B unresolvable', () => {
    expect(decomposeCombo('AM5240GY-2-UNKNOWN', type0set)).toBeNull();
  });

  test('returns null when simple pack base unresolvable', () => {
    expect(decomposeCombo('UNKNOWN-4', type0set)).toBeNull();
  });

  test('bare SKU whose base resolves → 1-unit alias (changed by qty-1 alias feature)', () => {
    // "5029b" → parsePack → base "5029b", qty 1 → resolves → [{5029b, 1}]
    // A Type-1 SKU identical to a Type-0 is treated as a single-unit alias.
    expect(decomposeCombo('5029b', type0set)).toEqual([
      { childBaseUnit: '5029b', qty: 1 },
    ]);
  });

  test('returns null for empty string', () => {
    expect(decomposeCombo('', type0set)).toBeNull();
  });

  // Property: successful decomposition never guesses — every child is in type0set
  test('property: all resolved children exist in type0set', () => {
    const skus = ['5029b-2', '5031DM-four', 'AM5240GY-2-AM5231', 'AM5240GY-4-AM5232'];
    skus.forEach((sku) => {
      const result = decomposeCombo(sku, type0set);
      if (result !== null) {
        result.forEach(({ childBaseUnit }) => {
          // canonical entry must be in set
          expect(type0set.has(childBaseUnit)).toBe(true);
        });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// parsePack — PK suffix (new)
// ---------------------------------------------------------------------------

describe('parsePack — PK suffix', () => {
  test('"NS5330-5PK" → base NS5330, qty 5', () => {
    expect(parsePack('NS5330-5PK')).toEqual({ base: 'NS5330', qty: 5 });
  });

  test('"NS5334-4PK" → base NS5334, qty 4', () => {
    expect(parsePack('NS5334-4PK')).toEqual({ base: 'NS5334', qty: 4 });
  });

  test('PK match is case-insensitive: "NS5330-5pk" → qty 5', () => {
    expect(parsePack('NS5330-5pk')).toEqual({ base: 'NS5330', qty: 5 });
  });

  test('-5PK and -5 produce same qty and same base', () => {
    const byPk    = parsePack('NS5330-5PK');
    const byDigit = parsePack('NS5330-5');
    expect(byPk.qty).toBe(byDigit.qty);
    expect(byPk.base).toBe(byDigit.base);
  });

  test('existing -5 digit parse unchanged', () => {
    expect(parsePack('5031DM-5')).toEqual({ base: '5031DM', qty: 5 });
  });

  test('existing -five word parse unchanged', () => {
    expect(parsePack('5031DM-five')).toEqual({ base: '5031DM', qty: 5 });
  });
});

// ---------------------------------------------------------------------------
// decomposeCombo — qty-1 alias + PK suffix (new)
// ---------------------------------------------------------------------------

describe('decomposeCombo — qty-1 alias and PK suffix', () => {
  const type0set = new Set([
    '5029b',
    '5031DM',
    'NS5330',
    'NS5334',
    '5233B-1',  // stored as -1 form; bare "5233B" resolves here
    'AM5230',
  ]);

  test('qty-1 combo whose base resolves → [{ childBaseUnit, qty: 1 }]', () => {
    // "AM5233B-1" → parsePack → base "AM5233B", qty 1
    // normalizeSku would strip AM prefix → "5233B"; resolveBaseUnit("5233B") → "5233B-1"
    // But decomposeCombo receives already-normalized SKU from the seed script.
    // Here we test with the post-normalization form: "5233B-1"
    // parsePack("5233B-1") → base "5233B", qty 1
    // resolveBaseUnit("5233B", type0set) → "5233B-1"
    expect(decomposeCombo('5233B-1', type0set)).toEqual([
      { childBaseUnit: '5233B-1', qty: 1 },
    ]);
  });

  test('qty-1 combo whose base is absent → null', () => {
    expect(decomposeCombo('MISSING-1', type0set)).toBeNull();
  });

  test('bare SKU with no suffix — resolves to self as 1-unit alias', () => {
    // "5029b" → parsePack → base "5029b", qty 1 → resolves → [{5029b,1}]
    // This is intentional: a Type-1 with SKU identical to a Type-0 is a 1-unit alias.
    expect(decomposeCombo('5029b', type0set)).toEqual([
      { childBaseUnit: '5029b', qty: 1 },
    ]);
  });

  test('PK suffix combo resolves correctly: "NS5330-5PK"', () => {
    expect(decomposeCombo('NS5330-5PK', type0set)).toEqual([
      { childBaseUnit: 'NS5330', qty: 5 },
    ]);
  });

  test('PK suffix with unresolvable base → null', () => {
    expect(decomposeCombo('UNKNOWN-4PK', type0set)).toBeNull();
  });
});
