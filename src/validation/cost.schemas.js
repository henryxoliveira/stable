/**
 * zod schemas for the cost calculator. Money arrives as text typed in dollars
 * ("$4,000.50") and leaves as integer cents, using the strict parser in
 * cost.service.js. Field names match the form; the result is renamed to the
 * database fields (rent → rentCents, …).
 */
import { z } from 'zod';
import { MAX_GROUP_SEATS } from '../config/limits.js';
import { parseDollarsToCents } from '../services/cost.service.js';

/** Treat "" / missing as "not given". JSON numbers become text for the money parser. */
const blankToUndefined = (value) =>
  value === '' || value === null || value === undefined ? undefined : value;
const numberToText = (value) => (typeof value === 'number' ? String(value) : value);

/** Required money field: text in dollars → integer cents. */
const money = z.preprocess(
  numberToText,
  z.string({ error: 'Enter an amount. Use 0 if there is none.' }).transform((value, ctx) => {
    const parsed = parseDollarsToCents(value);
    if ('error' in parsed) {
      ctx.addIssue({ code: 'custom', message: parsed.error });
      return z.NEVER;
    }
    return parsed.cents;
  }),
);

/** Optional money field: blank → null (no on-campus comparison). */
const optionalMoney = z.preprocess(
  (value) => blankToUndefined(numberToText(value)),
  money.optional().transform((cents) => cents ?? null),
);

/** Whole number in a range, with a default when left blank. */
const wholeNumber = ({ min, max, message }) =>
  z.coerce
    .number({ error: message })
    .int({ error: message })
    .min(min, { error: message })
    .max(max, { error: message });

export const createEstimateSchema = z
  .object({
    name: z
      .string({ error: 'Give this estimate a name.' })
      .trim()
      .min(1, { error: 'Give this estimate a name.' })
      .max(60, { error: 'Keep the name to 60 characters or fewer.' }),
    rent: money,
    utilities: money,
    parking: money,
    onCampusQuarterly: optionalMoney,
    people: z.preprocess(
      blankToUndefined,
      wholeNumber({
        min: 1,
        max: MAX_GROUP_SEATS,
        message: `Enter a whole number of people from 1 to ${MAX_GROUP_SEATS}.`,
      }).optional(),
    ),
    leaseMonths: z.preprocess(
      blankToUndefined,
      wholeNumber({
        min: 1,
        max: 24,
        message: 'Enter a lease length from 1 to 24 months.',
      }).default(12),
    ),
    quarters: z.preprocess(
      blankToUndefined,
      wholeNumber({ min: 1, max: 4, message: 'Enter 1 to 4 quarters.' }).default(3),
    ),
    groupId: z.preprocess(
      blankToUndefined,
      z.uuid({ error: 'Choose one of your groups.' }).optional(),
    ),
  })
  .transform(({ rent, utilities, parking, onCampusQuarterly, ...rest }) => ({
    ...rest,
    rentCents: rent,
    utilitiesCents: utilities,
    parkingCents: parking,
    onCampusQuarterlyCents: onCampusQuarterly,
  }));

export const estimateIdParams = z.object({ id: z.uuid() });

/** GET /costs?fromLease=<id>: pre-fill the form from one of my lease summaries. */
export const costsIndexQuery = z.object({
  fromLease: z.preprocess(blankToUndefined, z.uuid({ error: 'Unknown lease.' }).optional()),
});

export const MIN_COMPARE = 2;
export const MAX_COMPARE = 8;

/**
 * GET /costs/compare?ids=a&ids=b&people=3. With no ids, the page just shows the
 * picker. A single ?ids=x arrives as a string, so it is wrapped in an array.
 */
export const compareQuery = z
  .object({
    ids: z.preprocess(
      (value) => (value === undefined || value === '' ? [] : [value].flat()),
      z
        .array(z.uuid({ error: 'Pick estimates from your list.' }))
        .max(MAX_COMPARE, { error: `Pick at most ${MAX_COMPARE} estimates.` }),
    ),
    people: z.preprocess(
      blankToUndefined,
      wholeNumber({
        min: 1,
        max: MAX_GROUP_SEATS,
        message: `Enter a whole number of people from 1 to ${MAX_GROUP_SEATS}.`,
      }).default(2),
    ),
  })
  .superRefine(({ ids }, ctx) => {
    if (ids.length > 0 && ids.length < MIN_COMPARE) {
      ctx.addIssue({
        code: 'custom',
        path: ['ids'],
        message: `Pick at least ${MIN_COMPARE} estimates.`,
      });
    }
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['ids'], message: 'Pick each estimate only once.' });
    }
  });
