/**
 * Cost calculator math (roadmap B2). PURE: no database, no Express, no clock.
 *
 * All money is integer CENTS. We never use floating-point numbers for money,
 * because 0.1 + 0.2 !== 0.3 in JavaScript. Dollars typed by a user are parsed
 * by the shared helper in src/utils/money.js, and every split uses integer division.
 */
import { MAX_GROUP_SEATS } from '../config/limits.js';

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
