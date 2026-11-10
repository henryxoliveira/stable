/**
 * Unit tests for upcomingTerms(): the current SCU quarter plus the next 5.
 * Dates are fixed (Pacific time, the campus calendar), so these never go stale.
 */
import { describe, expect, it } from 'vitest';
import { upcomingTerms } from '../src/services/group.service.js';

const at = (iso) => upcomingTerms(new Date(iso));

describe('upcomingTerms()', () => {
  it('Nov 9 2026 (fall): FALL-2026 through WINTER-2028, rolling over the year after FALL', () => {
    expect(at('2026-11-09T12:00:00-08:00')).toEqual([
      'FALL-2026',
      'WINTER-2027',
      'SPRING-2027',
      'SUMMER-2027',
      'FALL-2027',
      'WINTER-2028',
    ]);
  });

  it('Jan 15 2027 (winter, new year): starts at WINTER-2027', () => {
    expect(at('2027-01-15T12:00:00-08:00')).toEqual([
      'WINTER-2027',
      'SPRING-2027',
      'SUMMER-2027',
      'FALL-2027',
      'WINTER-2028',
      'SPRING-2028',
    ]);
  });

  it('uses the quarter boundaries Jan/Apr/Jul/Sep', () => {
    expect(at('2027-03-31T12:00:00-07:00')[0]).toBe('WINTER-2027');
    expect(at('2027-04-01T12:00:00-07:00')[0]).toBe('SPRING-2027');
    expect(at('2027-06-30T12:00:00-07:00')[0]).toBe('SPRING-2027');
    expect(at('2027-07-01T12:00:00-07:00')[0]).toBe('SUMMER-2027');
    expect(at('2027-08-31T12:00:00-07:00')[0]).toBe('SUMMER-2027');
    expect(at('2027-09-01T12:00:00-07:00')[0]).toBe('FALL-2027');
  });

  it('reads the date in Pacific time: Dec 31, 8pm on campus is still FALL (already Jan 1 in UTC)', () => {
    expect(at('2026-12-31T20:00:00-08:00')[0]).toBe('FALL-2026');
    expect(at('2027-01-01T00:30:00-08:00')[0]).toBe('WINTER-2027');
  });

  it('always returns 6 terms', () => {
    expect(upcomingTerms()).toHaveLength(6);
  });
});
