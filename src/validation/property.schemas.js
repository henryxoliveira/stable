/**
 * zod schemas for properties, units, and floor plans (roadmap A2).
 * Field names match the forms. Optional fields left blank are saved as null,
 * so editing a form and clearing a box really clears it.
 */
import { z } from 'zod';
import { parseDollarsToCents } from '../utils/money.js';

/** Most people a unit can fit: the same as the largest roommate group. */
export const MAX_BEDS = 16;

/** "" / null / missing → undefined, so `.optional()` and `.default()` apply. */
const blank = (value) =>
  value === '' || value === null || value === undefined ? undefined : value;

const text = (label, max) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, { error: `${label} is required.` })
    .max(max, { error: `${label} must be ${max} characters or fewer.` });

/** Optional text: blank → null. */
const optionalText = (label, max) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? blank(value.trim()) : blank(value)),
    z
      .string()
      .max(max, { error: `${label} must be ${max} characters or fewer.` })
      .optional()
      .transform((value) => value ?? null),
  );

/** Whole number in a range. */
const wholeNumber = (label, min, max) =>
  z.coerce
    .number({ error: `${label} must be a number.` })
    .int({ error: `${label} must be a whole number.` })
    .min(min, { error: `${label} must be at least ${min}.` })
    .max(max, { error: `${label} must be at most ${max}.` });

/** Optional whole number: blank → null. */
const optionalWholeNumber = (label, min, max) =>
  z.preprocess(
    blank,
    wholeNumber(label, min, max)
      .optional()
      .transform((value) => value ?? null),
  );

/** Optional coordinate: blank → null. */
const coordinate = (label, limit) =>
  z.preprocess(
    blank,
    z.coerce
      .number({ error: `${label} must be a number.` })
      .min(-limit, { error: `${label} must be between -${limit} and ${limit}.` })
      .max(limit, { error: `${label} must be between -${limit} and ${limit}.` })
      .optional()
      .transform((value) => value ?? null),
  );

/** Money typed in dollars → integer cents. `fallback` is used when left blank. */
const money = (fallback) =>
  z.preprocess(
    (value) => blank(value) ?? fallback,
    z.unknown().transform((value, ctx) => {
      const parsed = parseDollarsToCents(value);
      if ('error' in parsed) {
        ctx.addIssue({ code: 'custom', message: parsed.error });
        return z.NEVER;
      }
      return parsed.cents;
    }),
  );

export const propertySchema = z
  .object({
    name: text('Name', 80),
    address: text('Street address', 120),
    city: text('City', 60),
    state: z.preprocess(
      blank,
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2}$/, { error: 'Use the two-letter state code, like CA.' })
        .default('CA'),
    ),
    postalCode: z
      .string({ error: 'ZIP code is required.' })
      .trim()
      .regex(/^\d{5}(-\d{4})?$/, { error: 'Enter a 5-digit ZIP code, like 95050.' }),
    latitude: coordinate('Latitude', 90),
    longitude: coordinate('Longitude', 180),
    description: optionalText('Description', 1000),
  })
  .superRefine((data, ctx) => {
    if ((data.latitude === null) !== (data.longitude === null)) {
      const path = data.latitude === null ? 'latitude' : 'longitude';
      ctx.addIssue({
        code: 'custom',
        path: [path],
        message: 'Enter both latitude and longitude, or neither.',
      });
    }
  });

/** Money fields arrive in dollars (`rent`) and leave as cents (`rentCents`). */
export const unitSchema = z
  .object({
    label: text('Unit label', 40),
    bedrooms: wholeNumber('Bedrooms', 0, 20),
    beds: wholeNumber('Beds', 1, MAX_BEDS),
    bathrooms: z.coerce
      .number({ error: 'Bathrooms must be a number.' })
      .min(0, { error: 'Bathrooms must be at least 0.' })
      .max(10, { error: 'Bathrooms must be at most 10.' })
      .multipleOf(0.5, { error: 'Use whole or half bathrooms, like 1 or 1.5.' }),
    squareFeet: optionalWholeNumber('Square feet', 1, 100_000),
    rent: money(undefined),
    utilities: money('0'),
    parking: money('0'),
  })
  .transform(({ rent, utilities, parking, ...rest }) => ({
    ...rest,
    rentCents: rent,
    utilitiesCents: utilities,
    parkingCents: parking,
  }));

export const floorPlanSchema = z.object({
  name: text('Floor plan name', 60),
  squareFeet: optionalWholeNumber('Square feet', 1, 100_000),
  notes: optionalText('Notes', 1000),
});

export const idParams = z.object({ id: z.uuid({ error: 'Invalid id.' }) });
