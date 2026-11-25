/**
 * Unit tests for the shared money helpers (no database, no HTTP). Used by the
 * cost calculator and the unit forms, so both refuse the same input with the
 * same message.
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

describe('parseDollarsToCents(): JSON numbers', () => {
  it.each([
    [1850, 185000],
    [19.99, 1999],
    [0, 0],
  ])('accepts the number %j → %i cents', (input, cents) => {
    expect(parseDollarsToCents(input)).toEqual({ cents });
  });

  it('refuses a number with float noise instead of rounding it', () => {
    expect(parseDollarsToCents(0.1 + 0.2).error).toMatch(/at most 2 digits/);
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

describe('centsToInput()', () => {
  it('gives back what a form field should show, and round-trips', () => {
    expect(centsToInput(240050)).toBe('2400.50');
    expect(centsToInput(0)).toBe('0.00');
    expect(parseDollarsToCents(centsToInput(123456)).cents).toBe(123456);
  });
});
