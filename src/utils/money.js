/**
 * Money helpers. All money in Stable is integer CENTS, never floating-point
 * dollars (0.1 + 0.2 !== 0.3 in JavaScript). Typed amounts are parsed from the
 * text digit by digit, so "$2,400.50" becomes exactly 240050.
 */

/** Largest amount accepted for one money field: $100,000.00. */
export const MAX_AMOUNT_CENTS = 100_000_00;

/**
 * Optional "$", then digits (plain, or grouped by commas in threes), then
 * optionally "." and 1–2 digits of cents.
 *   ok: 2400  2400.5  2400.50  2,400  $2,400.50  0
 *   no: 24,00  -5  1.2.3  .50  2400.505
 */
const AMOUNT_PATTERN = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/**
 * Turn what a user typed into integer cents.
 * @param {unknown} input  usually a string; JSON numbers are accepted too
 * @returns {{ cents: number } | { error: string }}
 */
export function parseDollarsToCents(input) {
  const text =
    typeof input === 'number' ? String(input) : typeof input === 'string' ? input.trim() : '';
  if (text === '') return { error: 'Enter an amount. Use 0 if there is none.' };
  if (text.includes('-')) return { error: "Amounts can't be negative." };

  const match = AMOUNT_PATTERN.exec(text);
  if (!match) return { error: 'Enter an amount like 1250 or 1250.50.' };

  const dollarDigits = match[1].replaceAll(',', '');
  // More than 6 digits of dollars is over the limit (and checked before Number()).
  if (dollarDigits.replace(/^0+/, '').length > 6) return tooBig();
  const cents = Number(dollarDigits) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return cents > MAX_AMOUNT_CENTS ? tooBig() : { cents };
}

const tooBig = () => ({ error: "Amounts can't be more than $100,000." });

/**
 * 240050 → "$2,400.50" (integer math only).
 * @param {number} cents
 */
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * 240050 → "2400.50", for putting a saved amount back into a form field.
 * @param {number} cents
 */
export function centsToInput(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
