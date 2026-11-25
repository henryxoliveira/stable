/**
 * Unit tests for the pure cost calculator math (no database, no HTTP).
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_AMOUNT_CENTS,
  computeEstimate,
  formatCents,
  parseDollarsToCents,
  splitCents,
} from '../src/services/cost.service.js';
import { MAX_GROUP_SEATS } from '../src/config/limits.js';

const base = {
  people: 3,
  rentCents: 0,
  utilitiesCents: 0,
  parkingCents: 0,
  leaseMonths: 12,
  onCampusQuarterlyCents: null,
  quarters: 3,
};

describe('splitCents()', () => {
  it('$4,000 rent + $200 utilities split 3 ways = $1,400.00 each (README scenario 22)', () => {
    const r = computeEstimate({ ...base, rentCents: 400000, utilitiesCents: 20000 });
    expect(r.monthlyTotalCents).toBe(420000);
    expect(r.shares).toEqual([140000, 140000, 140000]);
    expect(r.sharesDiffer).toBe(false);
    expect(formatCents(r.shares[0])).toBe('$1,400.00');
  });

  it('$4,000.00 split 3 ways = $1,333.34 + $1,333.33 + $1,333.33 (leftover cent to the first person)', () => {
    const { shares, sharesDiffer } = splitCents(400000, 3);
    expect(shares).toEqual([133334, 133333, 133333]);
    expect(shares.map(formatCents)).toEqual(['$1,333.34', '$1,333.33', '$1,333.33']);
    expect(sharesDiffer).toBe(true);
  });

  it('1 person pays the whole total', () => {
    expect(splitCents(123457, 1)).toEqual({
      totalCents: 123457,
      shares: [123457],
      sharesDiffer: false,
    });
  });

  it(`${MAX_GROUP_SEATS} people: shares add back up to the exact total and differ by at most 1 cent`, () => {
    const total = 1000001; // $10,000.01
    const { shares } = splitCents(total, MAX_GROUP_SEATS);
    expect(shares).toHaveLength(MAX_GROUP_SEATS);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
    expect(shares.filter((s) => s === 62501)).toHaveLength(1); // 1000001 % 16 = 1 leftover cent
  });

  it('a $0 total splits to $0 each', () => {
    expect(splitCents(0, 4).shares).toEqual([0, 0, 0, 0]);
  });

  it('rejects people outside 1–16 and non-integer totals', () => {
    expect(() => splitCents(100, 0)).toThrow(RangeError);
    expect(() => splitCents(100, MAX_GROUP_SEATS + 1)).toThrow(RangeError);
    expect(() => splitCents(100, 2.5)).toThrow(RangeError);
    expect(() => splitCents(10.5, 2)).toThrow(RangeError);
    expect(() => splitCents(-1, 2)).toThrow(RangeError);
  });
});

describe('parseDollarsToCents()', () => {
  it.each([
    ['4000', 400000],
    ['4000.5', 400050],
    ['4000.50', 400050],
    ['4,000', 400000],
    ['$4,000.50', 400050],
    ['$4000', 400000],
    ['  1250.05  ', 125005],
    ['0', 0],
    ['0.01', 1],
    ['12,345.67', 1234567],
    ['100000', MAX_AMOUNT_CENTS],
    ['$100,000.00', MAX_AMOUNT_CENTS],
  ])('accepts %j → %i cents', (input, cents) => {
    expect(parseDollarsToCents(input)).toEqual({ cents });
  });

  it.each([
    ['', /Enter an amount/],
    ['   ', /Enter an amount/],
    [undefined, /Enter an amount/],
    ['-5', /negative/],
    ['--5', /negative/],
    ['$-5', /negative/],
    ['4000.505', /at most 2 digits/],
    ['4000.123', /at most 2 digits/],
    ['40a0', /like 1250 or 1250\.50/],
    ['abc', /like 1250 or 1250\.50/],
    ['4,00', /like 1250 or 1250\.50/],
    ['40,00,000', /like 1250 or 1250\.50/],
    ['1.2.3', /like 1250 or 1250\.50/],
    ['.50', /like 1250 or 1250\.50/],
    ['4000.', /like 1250 or 1250\.50/],
    ['$', /like 1250 or 1250\.50/],
    ['$$4000', /like 1250 or 1250\.50/],
    ['4000$', /like 1250 or 1250\.50/],
    ['1e5', /like 1250 or 1250\.50/],
    ['100000.01', /more than \$100,000/],
    ['$100,001', /more than \$100,000/],
    ['99999999999999999999', /more than \$100,000/],
  ])('rejects %j with a plain-English message', (input, message) => {
    const result = parseDollarsToCents(input);
    expect(result.cents).toBeUndefined();
    expect(result.error).toMatch(message);
  });
});

describe('computeEstimate(): on- vs. off-campus', () => {
  // $3,000 + $150 + $50 = $3,200/month for 3 people → shares 106667, 106667, 106666.
  const offCampus = { ...base, rentCents: 300000, utilitiesCents: 15000, parkingCents: 5000 };

  it('uses the largest monthly share × lease months vs. quarterly × quarters', () => {
    const r = computeEstimate({ ...offCampus, onCampusQuarterlyCents: 500000 }); // $5,000/quarter
    expect(r.maxMonthlyShareCents).toBe(106667);
    expect(r.comparison).toEqual({
      offCampusPerPersonCents: 1280004, // 106667 × 12
      onCampusPerPersonCents: 1500000, // 500000 × 3
      differenceCents: 219996,
      cheaper: 'off_campus',
    });
  });

  it('reports on campus as cheaper when it is', () => {
    const r = computeEstimate({ ...offCampus, onCampusQuarterlyCents: 300000, quarters: 3 });
    expect(r.comparison.cheaper).toBe('on_campus');
    expect(r.comparison.differenceCents).toBe(1280004 - 900000);
  });

  it('reports "same" when they are equal', () => {
    const r = computeEstimate({
      ...base,
      people: 1,
      rentCents: 100000,
      leaseMonths: 9,
      onCampusQuarterlyCents: 300000,
      quarters: 3,
    });
    expect(r.comparison).toMatchObject({ differenceCents: 0, cheaper: 'same' });
  });

  it('skips the comparison when no on-campus cost is entered', () => {
    expect(computeEstimate(offCampus).comparison).toBeNull();
  });
});

describe('formatCents()', () => {
  it('formats with commas and 2 decimals using integer math', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(10000000)).toBe('$100,000.00');
    expect(formatCents(-133334)).toBe('-$1,333.34');
  });
});
