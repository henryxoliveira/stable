/**
 * Cost calculator math (roadmap B2). PURE: no database, no Express, no clock.
 *
 * All money is integer CENTS. We never use floating-point numbers for money,
 * because 0.1 + 0.2 !== 0.3 in JavaScript. Dollars typed by a user are parsed
 * from the text digit by digit, and every split uses integer division.
 */
import { MAX_GROUP_SEATS } from '../config/limits.js';

/** Largest amount accepted for any one money field: $100,000.00. */
export const MAX_AMOUNT_CENTS = 100_000_00;

/**
 * Optional "$", then digits (either plain, or grouped by commas in threes),
 * then optionally "." and 1–2 digits of cents.
 *   ok: 4000  4000.5  4000.50  4,000  $4,000.50  0
 *   no: 4,00  40,00,000  --5  1.2.3  .50  4000.505
 */
const AMOUNT_PATTERN = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/**
 * Turn what a user typed ("$4,000.50") into integer cents (400050).
 * Returns `{ cents }` on success or `{ error }` with a plain-English message.
 * @param {unknown} input
 * @returns {{ cents: number } | { error: string }}
 */
export function parseDollarsToCents(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (text === '') return { error: 'Enter an amount. Use 0 if there is none.' };
  if (text.includes('-')) return { error: "Amounts can't be negative." };
  if (/\.\d{3,}$/.test(text)) {
    return { error: 'Use at most 2 digits after the decimal point (cents).' };
  }

  const match = AMOUNT_PATTERN.exec(text);
  if (!match) return { error: 'Enter an amount like 1250 or 1250.50.' };

  const dollarDigits = match[1].replaceAll(',', '');
  // Too many digits can't be under the limit (and would lose precision as a Number).
  if (dollarDigits.replace(/^0+/, '').length > 6) return tooBig();

  const centDigits = (match[2] ?? '').padEnd(2, '0'); // "5" → "50", "" → "00"
  const cents = Number(dollarDigits) * 100 + Number(centDigits); // integers only
  if (cents > MAX_AMOUNT_CENTS) return tooBig();
  return { cents };
}

const tooBig = () => ({ error: "Amounts can't be more than $100,000." });

/**
 * Split a total between people as evenly as cents allow.
 * Everyone pays floor(total / people); the leftover cents (fewer than `people`)
 * go one each to the first few people.
 *   splitCents(400000, 3) → { shares: [133334, 133333, 133333], sharesDiffer: true }
 * @param {number} totalCents  non-negative integer
 * @param {number} people      integer, 1..MAX_GROUP_SEATS
 */
export function splitCents(totalCents, people) {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new RangeError('totalCents must be a non-negative integer.');
  }
  if (!Number.isInteger(people) || people < 1 || people > MAX_GROUP_SEATS) {
    throw new RangeError(`people must be an integer from 1 to ${MAX_GROUP_SEATS}.`);
  }
  const base = Math.floor(totalCents / people);
  const leftover = totalCents % people;
  const shares = Array.from({ length: people }, (_, i) => (i < leftover ? base + 1 : base));
  return { totalCents, shares, sharesDiffer: leftover > 0 };
}

/**
 * Everything the estimate page shows, computed fresh from the saved inputs.
 * The on-campus comparison uses the LARGEST monthly share (the most anyone in
 * the group pays) times the lease length, versus the quarterly on-campus cost
 * times the number of quarters.
 * @param {{ people: number, rentCents: number, utilitiesCents: number,
 *   parkingCents: number, leaseMonths: number,
 *   onCampusQuarterlyCents: number|null, quarters: number }} e
 */
export function computeEstimate(e) {
  const monthlyTotalCents = e.rentCents + e.utilitiesCents + e.parkingCents;
  const split = splitCents(monthlyTotalCents, e.people);
  const maxMonthlyShareCents = split.shares[0]; // the first share is always the largest

  let comparison = null;
  if (e.onCampusQuarterlyCents !== null && e.onCampusQuarterlyCents !== undefined) {
    const offCampusPerPersonCents = maxMonthlyShareCents * e.leaseMonths;
    const onCampusPerPersonCents = e.onCampusQuarterlyCents * e.quarters;
    const differenceCents = offCampusPerPersonCents - onCampusPerPersonCents;
    comparison = {
      offCampusPerPersonCents,
      onCampusPerPersonCents,
      differenceCents: Math.abs(differenceCents),
      cheaper: differenceCents < 0 ? 'off_campus' : differenceCents > 0 ? 'on_campus' : 'same',
    };
  }

  return {
    monthlyTotalCents,
    shares: split.shares,
    sharesDiffer: split.sharesDiffer,
    maxMonthlyShareCents,
    comparison,
  };
}

/**
 * 133334 → "$1,333.34". Integer math only; used by the views.
 * @param {number} cents
 */
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}$${dollars}.${rest}`;
}
