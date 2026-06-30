import { getFamilySku } from '../sku';

// ---------------------------------------------------------------------------
// Without allSkus — always-strip mode (backward compat for internal use)
// ---------------------------------------------------------------------------

describe('getFamilySku (no allSkus — always strip)', () => {
  describe('digit suffix', () => {
    const cases: [string, string][] = [
      ['AM5234-4',  'AM5234'],
      ['AM5234-1',  'AM5234'],
      ['AM5237-10', 'AM5237'],
      ['AM5237-20', 'AM5237'],
      ['AM5303-1',  'AM5303'],
      ['15044BY-2', '15044BY'],
      ['NS5340',    'NS5340'],
      ['AM5230',    'AM5230'],
      ['AM5263',    'AM5263'],
    ];
    test.each(cases)('getFamilySku(%s) === %s', (input, expected) => {
      expect(getFamilySku(input)).toBe(expected);
    });

    test('strips only ONE trailing digit suffix', () => {
      // "AM5234-4-2" → strip last "-2" → "AM5234-4"
      expect(getFamilySku('AM5234-4-2')).toBe('AM5234-4');
    });
  });

  describe('spelled-out number suffix', () => {
    const cases: [string, string][] = [
      ['AM5234-five',    'AM5234'],
      ['AM5234-two',     'AM5234'],
      ['AM5234-one',     'AM5234'],
      ['AM5234-ten',     'AM5234'],
      ['AM5234-twelve',  'AM5234'],
      ['AM5234-twenty',  'AM5234'],
      ['AM5234-FIVE',    'AM5234'],   // case-insensitive
      ['AM5234-Five',    'AM5234'],   // mixed case
    ];
    test.each(cases)('getFamilySku(%s) === %s', (input, expected) => {
      expect(getFamilySku(input)).toBe(expected);
    });

    test('does NOT strip non-number word suffix', () => {
      // "AM5234-hw" is not a number word → unchanged
      expect(getFamilySku('AM5234-hw')).toBe('AM5234-hw');
    });
  });

  describe('letter-suffix SKUs — unchanged', () => {
    // AM5234B = separate physical product, never strip
    const cases: [string, string][] = [
      ['AM5234B',   'AM5234B'],
      ['AM5237A',   'AM5237A'],
      ['15044BY',   '15044BY'],
    ];
    test.each(cases)('getFamilySku(%s) === %s (unchanged)', (input, expected) => {
      expect(getFamilySku(input)).toBe(expected);
    });
  });

  describe('combo SKUs — unchanged', () => {
    const cases: [string, string][] = [
      ['AM5237-4-AM5273',      'AM5237-4-AM5273'],
      ['AM5237-4-AM5235-HW',   'AM5237-4-AM5235-HW'],
      ['AM5237-2-AM5274',      'AM5237-2-AM5274'],
    ];
    test.each(cases)('getFamilySku(%s) === %s (unchanged)', (input, expected) => {
      expect(getFamilySku(input)).toBe(expected);
    });
  });

  test('empty string returns empty string', () => {
    expect(getFamilySku('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// With allSkus — sibling-aware mode (for dataset-level grouping)
// ---------------------------------------------------------------------------

describe('getFamilySku (with allSkus — sibling check)', () => {
  describe('digit suffix — sibling found → strip', () => {
    test('AM5237-10 + AM5237-20 → AM5237', () => {
      const skus = ['AM5237-10', 'AM5237-20'];
      expect(getFamilySku('AM5237-10', skus)).toBe('AM5237');
      expect(getFamilySku('AM5237-20', skus)).toBe('AM5237');
    });

    test('AM5234-1 + AM5234-2 → AM5234', () => {
      const skus = ['AM5234-1', 'AM5234-2', 'AM5234-5'];
      expect(getFamilySku('AM5234-1', skus)).toBe('AM5234');
      expect(getFamilySku('AM5234-2', skus)).toBe('AM5234');
      expect(getFamilySku('AM5234-5', skus)).toBe('AM5234');
    });

    test('sibling is the bare base itself (AM5237 + AM5237-1)', () => {
      const skus = ['AM5237', 'AM5237-1'];
      expect(getFamilySku('AM5237-1', skus)).toBe('AM5237');
      // bare base stays unchanged
      expect(getFamilySku('AM5237', skus)).toBe('AM5237');
    });
  });

  describe('digit suffix — lone SKU → unchanged', () => {
    test('5116-2 alone stays 5116-2', () => {
      expect(getFamilySku('5116-2', ['5116-2'])).toBe('5116-2');
    });

    test('AM5237-100 alone stays AM5237-100', () => {
      expect(getFamilySku('AM5237-100', ['AM5237-100'])).toBe('AM5237-100');
    });

    test('5048-24MDM alone stays 5048-24MDM', () => {
      expect(getFamilySku('5048-24MDM', ['5048-24MDM'])).toBe('5048-24MDM');
    });
  });

  describe('spelled-out number suffix — sibling found → strip', () => {
    test('AM5234-five nests under AM5234 when AM5234-2 present', () => {
      const skus = ['AM5234-five', 'AM5234-2'];
      expect(getFamilySku('AM5234-five', skus)).toBe('AM5234');
      expect(getFamilySku('AM5234-2', skus)).toBe('AM5234');
    });

    test('AM5234-five nests under AM5234 when bare AM5234 present', () => {
      const skus = ['AM5234', 'AM5234-five'];
      expect(getFamilySku('AM5234-five', skus)).toBe('AM5234');
    });

    test('spelled-out number treated same as digit — AM5234-five = AM5234-5', () => {
      // Both map to AM5234 when siblings exist
      const skus = ['AM5234-five', 'AM5234-two'];
      expect(getFamilySku('AM5234-five', skus)).toBe('AM5234');
      expect(getFamilySku('AM5234-two', skus)).toBe('AM5234');
    });

    test('lone spelled-out-number SKU stays unchanged', () => {
      // No sibling → return original
      expect(getFamilySku('AM5234-five', ['AM5234-five'])).toBe('AM5234-five');
    });
  });

  describe('letter-suffix SKUs — ALWAYS unchanged regardless of dataset', () => {
    test('AM5234B stays standalone even when AM5234-2 present', () => {
      const skus = ['AM5234B', 'AM5234-2', 'AM5243B'];
      // Letter suffix → not strippable → unchanged always
      expect(getFamilySku('AM5234B', skus)).toBe('AM5234B');
      expect(getFamilySku('AM5243B', skus)).toBe('AM5243B');
    });
  });

  describe('combo SKUs — ALWAYS unchanged regardless of dataset', () => {
    test('combo stays standalone even when non-combo siblings present', () => {
      const skus = ['AM5237-4-AM5273', 'AM5237-4-AM5235-HW', 'AM5237-2-AM5274', 'AM5237-1'];
      expect(getFamilySku('AM5237-4-AM5273', skus)).toBe('AM5237-4-AM5273');
      expect(getFamilySku('AM5237-4-AM5235-HW', skus)).toBe('AM5237-4-AM5235-HW');
      expect(getFamilySku('AM5237-2-AM5274', skus)).toBe('AM5237-2-AM5274');
    });
  });

  describe('Set<string> overload works same as array', () => {
    test('accepts Set<string>', () => {
      const skuSet = new Set(['AM5237-10', 'AM5237-20']);
      expect(getFamilySku('AM5237-10', skuSet)).toBe('AM5237');
    });
  });

  test('empty string returns empty string', () => {
    expect(getFamilySku('', ['AM5234-1', 'AM5234-2'])).toBe('');
  });
});
