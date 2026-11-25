/**
 * Unit tests for the money helpers (no database, no HTTP).
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_AMOUNT_CENTS,
  centsToInput,
  formatCents,
  parseDollarsToCents,
} from '../src/utils/money.js';

describe('parseDollarsToCents()', () => {
  it.each([
    ['2400', 240000],
    ['2400.5', 240050],
    ['2400.50', 240050],
    ['$2,400.50', 240050],
    ['  75 ', 7500],
    ['0', 0],
    ['0.01', 1],
    ['100000', MAX_AMOUNT_CENTS],
    [1850, 185000],
    [19.99, 1999],
  ])('%j → %i cents', (input, cents) => {
    expect(parseDollarsToCents(input)).toEqual({ cents });
  });

  it.each([
    ['', 'Enter an amount'],
    [undefined, 'Enter an amount'],
    ['-5', 'negative'],
    ['24,00', 'like 1250'],
    ['.50', 'like 1250'],
    ['1.2.3', 'like 1250'],
    ['12.345', 'like 1250'],
    ['ten', 'like 1250'],
    ['100000.01', 'more than $100,000'],
    ['9999999999999999', 'more than $100,000'],
  ])('%j is refused (%s)', (input, message) => {
    expect(parseDollarsToCents(input).error).toContain(message);
  });
});

describe('formatting', () => {
  it('formatCents uses dollars, commas, and two decimals', () => {
    expect(formatCents(240050)).toBe('$2,400.50');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(-7500)).toBe('-$75.00');
  });

  it('centsToInput gives back what a form field should show', () => {
    expect(centsToInput(240050)).toBe('2400.50');
    expect(centsToInput(0)).toBe('0.00');
    expect(parseDollarsToCents(centsToInput(123456)).cents).toBe(123456); // round trip
  });
});
