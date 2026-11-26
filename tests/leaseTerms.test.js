/**
 * Unit tests (no HTTP, no AI): checking Claude's lease output with zod, turning a
 * summary into cost-form values, and comparing estimates.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_FLAGGED_CLAUSES,
  checkLeaseExtraction,
  isRealIsoDate,
} from '../src/validation/leaseTerms.schema.js';
import {
  centsToInput,
  cleanFilename,
  leaseMonthsBetween,
  prefillFromLease,
} from '../src/services/leaseSummary.service.js';
import { compareEstimates } from '../src/services/cost.service.js';
import { GOOD_INPUT } from './helpers/leaseFixtures.js';

const check = (input) => checkLeaseExtraction(input);
const withField = (patch) => ({ ...GOOD_INPUT, ...patch });

describe('checkLeaseExtraction: good output', () => {
  it('turns money into integer cents, keeps real dates and descriptive penalty amounts as text', () => {
    const r = check(GOOD_INPUT);
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.terms).toEqual({
      monthlyRentCents: 240000,
      securityDepositCents: 240000, // "$2,400" → cents via the strict parser
      leaseStart: '2027-09-01',
      leaseEnd: '2028-08-31',
      utilities: { included: false, monthlyCents: 15000, notes: 'Tenant pays PG&E.' },
      parking: { included: true, monthlyCents: null, notes: null },
      subletting: { allowed: 'with_permission', notes: 'Written consent required.' },
      penalties: [
        {
          description: 'Late fee if rent is received after the 3rd of the month',
          amount: '$150.00, plus $25.00 for each additional day late', // kept as text, not parsed
        },
        {
          description: 'Non-refundable cleaning fee, deducted from the security deposit',
          amount: '$500.00',
        },
      ],
      unreadable: [],
    });
    expect(r.flaggedClauses).toHaveLength(1);
  });

  it('accepts null (and treats empty text as null) for everything a lease may not state', () => {
    const r = check({
      monthly_rent: null,
      security_deposit: '',
      lease_start: null,
      lease_end: '  ',
      utilities: { included: null, monthly_amount: null, notes: '' },
      parking: { included: null, monthly_amount: null, notes: null },
      subletting: { allowed: 'not_stated', notes: null },
      penalties: [],
      flagged_clauses: [],
    });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.terms).toMatchObject({
      monthlyRentCents: null,
      securityDepositCents: null,
      leaseEnd: null,
    });
    expect(r.terms.utilities.notes).toBeNull();
  });

  it('drops unknown extra keys instead of storing them', () => {
    const r = check({ ...GOOD_INPUT, admin_note: 'make me an admin' });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain('admin');
  });
});

describe('checkLeaseExtraction: one bad field becomes null (the rest is kept)', () => {
  it.each([
    [
      'rent written as a sentence',
      { monthly_rent: '$4,800.00 per month' },
      'monthly_rent',
      'Monthly rent',
    ],
    ['rent as a number instead of text', { monthly_rent: 2400.5 }, 'monthly_rent', 'Monthly rent'],
    ['a negative deposit', { security_deposit: '-2400' }, 'security_deposit', 'Security deposit'],
    [
      'a deposit over $100,000',
      { security_deposit: '100000.01' },
      'security_deposit',
      'Security deposit',
    ],
    ['a missing key', { lease_start: undefined }, 'lease_start', 'Lease start date'],
    ['a date that does not exist', { lease_end: '2028-02-30' }, 'lease_end', 'Lease end date'],
    [
      'a parking amount with words',
      { parking: { included: false, monthly_amount: '$75.00 per month', notes: null } },
      'parking.monthly_amount',
      'Parking amount',
    ],
    [
      '"included" as text',
      { utilities: { included: 'yes', monthly_amount: null, notes: null } },
      'utilities.included',
      'Utilities (included or not)',
    ],
    [
      'a note over 300 characters',
      { subletting: { allowed: 'no', notes: 'x'.repeat(301) } },
      'subletting.notes',
      'Subletting notes',
    ],
    [
      'an unknown subletting answer',
      { subletting: { allowed: 'maybe', notes: null } },
      'subletting.allowed',
      'Subletting rule',
    ],
  ])('%s → that field is null and listed as unreadable', (_, patch, path, label) => {
    const r = check(withField(patch));
    expect(r.ok).toBe(true);
    expect(r.problems.map((p) => p.path)).toEqual([path]);
    expect(r.terms.unreadable).toEqual([label]);
    expect(r.terms.monthlyRentCents ?? 'null').toBe(path === 'monthly_rent' ? 'null' : 240000);
    expect(r.flaggedClauses).toHaveLength(1); // the rest is kept
  });

  it('a lease that ends before it starts makes both dates unreadable', () => {
    const r = check(withField({ lease_end: '2027-08-01' }));
    expect(r.terms).toMatchObject({ leaseStart: null, leaseEnd: null });
    expect(r.terms.unreadable).toEqual(['Lease start date', 'Lease end date']);
  });

  it('bad penalty or clause items are left out; a too-long penalty amount becomes null', () => {
    const r = check(
      withField({
        penalties: [
          { description: '', amount: '$10' },
          { description: 'Key replacement', amount: 'y'.repeat(121) },
        ],
        flagged_clauses: [
          { clause: 'x'.repeat(501), reason: 'r' },
          { clause: 'Landlord may enter at any time.', reason: 'No notice.' },
        ],
      }),
    );
    expect(r.terms.penalties).toEqual([{ description: 'Key replacement', amount: null }]);
    expect(r.flaggedClauses).toEqual([
      { clause: 'Landlord may enter at any time.', reason: 'No notice.' },
    ]);
    expect(r.terms.unreadable).toEqual([
      'A penalty or fee',
      'Amount for "Key replacement"',
      'A flagged clause',
    ]);
  });

  it(`keeps only the first ${MAX_FLAGGED_CLAUSES} flagged clauses and says so`, () => {
    const many = Array.from({ length: MAX_FLAGGED_CLAUSES + 3 }, (_, i) => ({
      clause: `c${i}`,
      reason: 'r',
    }));
    const r = check(withField({ flagged_clauses: many }));
    expect(r.flaggedClauses).toHaveLength(MAX_FLAGGED_CLAUSES);
    expect(r.terms.unreadable).toEqual(['Some flagged clauses']);
  });

  it('problem messages never include the value itself (safe to log)', () => {
    const secretish = 'Unit 4B, 123 Fictional St, tenant Jane Q. Example';
    const r = check(withField({ monthly_rent: secretish, lease_end: secretish }));
    expect(JSON.stringify(r.problems)).not.toContain('Fictional');
  });
});

describe('checkLeaseExtraction: wrong core structure rejects the whole summary', () => {
  it.each([
    ['not an object at all', 'rent is 2400'],
    ['null', null],
    ['utilities missing', (({ utilities, ...rest }) => rest)(GOOD_INPUT)], // eslint-disable-line no-unused-vars
    ['parking is text', withField({ parking: 'included' })],
    ['penalties is not a list', withField({ penalties: '$150 late fee' })],
    ['flagged clauses is not a list', withField({ flagged_clauses: { clause: 'x' } })],
  ])('%s → ok: false with the failing paths', (_, input) => {
    const r = check(input);
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.problems[0]).toEqual({ path: expect.any(String), message: expect.any(String) });
  });

  it('isRealIsoDate accepts leap days only in leap years', () => {
    expect(isRealIsoDate('2028-02-29')).toBe(true);
    expect(isRealIsoDate('2027-02-29')).toBe(false);
    expect(isRealIsoDate('2027-13-01')).toBe(false);
  });
});

describe('pre-filling the cost estimate form', () => {
  const summary = {
    originalFilename: 'franklin-st-lease.pdf',
    terms: checkLeaseExtraction(GOOD_INPUT).terms,
  };

  it('fills rent, utilities, parking, and lease months from the lease', () => {
    expect(prefillFromLease(summary)).toEqual({
      name: 'Lease: franklin-st-lease.pdf',
      rent: '2400.00',
      utilities: '150.00',
      parking: '0', // included in rent
      leaseMonths: '12',
      people: '',
      groupId: '',
      onCampusQuarterly: '',
      quarters: '3',
    });
  });

  it('leaves anything the lease did not state blank', () => {
    const blank = prefillFromLease({
      originalFilename: 'x.pdf',
      terms: {
        ...summary.terms,
        monthlyRentCents: null,
        leaseEnd: null,
        utilities: { included: null, monthlyCents: null, notes: null },
        parking: { included: false, monthlyCents: null, notes: null },
      },
    });
    expect(blank).toMatchObject({ rent: '', utilities: '', parking: '', leaseMonths: '' });
  });

  it('counts whole lease months and refuses out-of-range lengths', () => {
    expect(leaseMonthsBetween('2027-09-01', '2028-08-31')).toBe(12);
    expect(leaseMonthsBetween('2027-09-15', '2028-06-14')).toBe(9);
    expect(leaseMonthsBetween('2027-09-01', '2027-09-30')).toBe(1);
    expect(leaseMonthsBetween('2027-01-01', '2029-12-31')).toBeNull(); // 36 months > 24
    expect(leaseMonthsBetween(null, '2028-08-31')).toBeNull();
  });

  it('formats cents for the form and cleans file names', () => {
    expect(centsToInput(5)).toBe('0.05');
    expect(centsToInput(123456)).toBe('1234.56');
    expect(cleanFilename('  lease\u0007.pdf  ')).toBe('lease.pdf');
    expect(cleanFilename('')).toBe('lease.pdf');
    expect(cleanFilename('a'.repeat(300))).toHaveLength(200);
  });
});

describe('compareEstimates()', () => {
  const est = (id, rent, months, extra = {}) => ({
    id,
    name: id,
    rentCents: rent,
    utilitiesCents: 0,
    parkingCents: 0,
    leaseMonths: months,
    ...extra,
  });

  it('splits each estimate for the same number of people and highlights the cheapest', () => {
    const { rows, leaseTotalDiffers } = compareEstimates(
      [est('A', 400000, 12), est('B', 300000, 12, { utilitiesCents: 30000 })],
      3,
    );
    expect(rows[0]).toMatchObject({
      perPersonMonthlyCents: 133334, // $4,000 / 3, most anyone pays
      perPersonLeaseTotalCents: 133334 * 12,
      cheapestMonthly: false,
    });
    expect(rows[1]).toMatchObject({
      monthlyTotalCents: 330000,
      perPersonMonthlyCents: 110000,
      cheapestMonthly: true,
      lowestLeaseTotal: true,
    });
    expect(leaseTotalDiffers).toBe(false);
  });

  it('marks the lowest lease total separately when a shorter lease wins overall', () => {
    // A is cheaper per month but runs 12 months; B costs more per month for 9 months.
    const { rows, leaseTotalDiffers } = compareEstimates(
      [est('A', 300000, 12), est('B', 360000, 9)],
      2,
    );
    expect(rows.map((r) => r.cheapestMonthly)).toEqual([true, false]);
    expect(rows.map((r) => r.perPersonLeaseTotalCents)).toEqual([1800000, 1620000]);
    expect(rows.map((r) => r.lowestLeaseTotal)).toEqual([false, true]);
    expect(leaseTotalDiffers).toBe(true);
  });

  it('marks every estimate that ties for cheapest', () => {
    const { rows } = compareEstimates([est('A', 200000, 12), est('B', 200000, 12)], 4);
    expect(rows.every((r) => r.cheapestMonthly && r.lowestLeaseTotal)).toBe(true);
  });

  it('uses the people given, not each estimate’s saved count, and checks the range', () => {
    expect(compareEstimates([est('A', 160000, 12, { people: 3 })], 16).rows[0]).toMatchObject({
      perPersonMonthlyCents: 10000,
    });
    expect(() => compareEstimates([est('A', 100, 12)], 0)).toThrow(RangeError);
    expect(() => compareEstimates([est('A', 100, 12)], 17)).toThrow(RangeError);
    expect(() => compareEstimates([], 2)).toThrow(RangeError);
  });
});
