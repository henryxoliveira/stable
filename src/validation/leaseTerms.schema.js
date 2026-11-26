/**
 * Server-side check of what Claude extracted from a lease. The model is asked for
 * structured output, but we never trust it blindly.
 *
 * Two levels:
 *  1. CORE STRUCTURE (zod): the answer must be an object whose utilities, parking,
 *     and subletting are objects and whose penalties and flagged clauses are lists.
 *     If not, the whole summary is rejected.
 *  2. EACH FIELD on its own: if one field is bad, only that field becomes null and
 *     its friendly name goes into `terms.unreadable`, so the page can say "couldn't
 *     be read" and the student fills it in. One odd value no longer sinks everything.
 *
 * Field rules:
 *  - True money fields (rent, deposit, utilities amount, parking amount) must be a
 *    plain amount ("1250.00", "$1,250"); they go through the cost calculator's strict
 *    parser → integer cents. No floating-point math.
 *  - Penalty amounts are DESCRIPTIVE ("$150.00, plus $25.00 for each additional day"),
 *    so they are kept as short text, not parsed.
 *  - Dates must be real calendar dates (YYYY-MM-DD); if the lease would end before
 *    it starts, both dates are treated as unreadable.
 *  - Empty text counts as "not stated" (null). Text has length caps.
 *
 * Problem messages never include the value itself, so they are safe to log.
 */
import { z } from 'zod';
import { parseDollarsToCents } from '../services/cost.service.js';

export const MAX_FLAGGED_CLAUSES = 20;
export const MAX_PENALTIES = 20;
export const SUBLETTING_VALUES = ['yes', 'no', 'with_permission', 'not_stated'];

/** True only for a real calendar date written as YYYY-MM-DD. */
export function isRealIsoDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// --- Field schemas -----------------------------------------------------------

/** "" or "   " → null ("not stated"). */
const blankToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);

const moneyField = z.preprocess(
  blankToNull,
  z
    .string({ error: 'Expected a plain amount or null.' })
    .nullable()
    .transform((value, ctx) => {
      if (value === null) return null;
      const parsed = parseDollarsToCents(value);
      if ('error' in parsed) {
        ctx.addIssue({ code: 'custom', message: 'Not a plain amount (like 1250.00).' });
        return z.NEVER;
      }
      return parsed.cents;
    }),
);

const dateField = z.preprocess(
  blankToNull,
  z
    .string({ error: 'Expected a date or null.' })
    .refine(isRealIsoDate, { error: 'Not a real date in YYYY-MM-DD form.' })
    .nullable(),
);

const booleanField = z.boolean({ error: 'Expected true, false, or null.' }).nullable();
const noteField = (max) =>
  z.preprocess(
    blankToNull,
    z.string({ error: 'Expected text or null.' }).trim().max(max).nullable(),
  );
const requiredText = (max) => z.string({ error: 'Expected text.' }).trim().min(1).max(max);
const sublettingField = z.enum(SUBLETTING_VALUES, { error: 'Not a known subletting answer.' });

// --- Core structure (rejects the whole summary) -----------------------------

const objectOf = z.record(z.string(), z.unknown());
const coreSchema = z.object({
  utilities: objectOf,
  parking: objectOf,
  subletting: objectOf,
  penalties: z.array(z.unknown()),
  flagged_clauses: z.array(z.unknown()),
});

/** Friendly names shown to the student for fields that couldn't be read. */
const LABELS = {
  monthly_rent: 'Monthly rent',
  security_deposit: 'Security deposit',
  lease_start: 'Lease start date',
  lease_end: 'Lease end date',
  'utilities.included': 'Utilities (included or not)',
  'utilities.monthly_amount': 'Utilities amount',
  'utilities.notes': 'Utilities notes',
  'parking.included': 'Parking (included or not)',
  'parking.monthly_amount': 'Parking amount',
  'parking.notes': 'Parking notes',
  'subletting.allowed': 'Subletting rule',
  'subletting.notes': 'Subletting notes',
};

/**
 * Check the `record_lease_terms` tool input.
 * @param {unknown} input
 * @returns {{ ok: false, problems: { path: string, message: string }[] }
 *   | { ok: true, terms: object, flaggedClauses: object[], problems: { path: string, message: string }[] }}
 *   `problems` lists every path that failed (for logging); values are never included.
 */
export function checkLeaseExtraction(input) {
  const core = coreSchema.safeParse(input);
  if (!core.success) {
    return {
      ok: false,
      problems: core.error.issues.map((i) => ({
        path: i.path.join('.') || '(root)',
        message: i.message,
      })),
    };
  }

  const problems = [];
  const unreadable = [];
  const note = (path, message, label = LABELS[path]) => {
    problems.push({ path, message });
    if (label && !unreadable.includes(label)) unreadable.push(label);
  };
  /** Parse one field; on failure record it and use null. */
  const field = (schema, value, path) => {
    const r = schema.safeParse(value);
    if (r.success) return r.data;
    note(path, r.error.issues[0].message);
    return null;
  };

  const costItem = (name) => {
    const item = input[name];
    return {
      included: field(booleanField, item.included, `${name}.included`),
      monthlyCents: field(moneyField, item.monthly_amount, `${name}.monthly_amount`),
      notes: field(noteField(300), item.notes, `${name}.notes`),
    };
  };

  let leaseStart = field(dateField, input.lease_start, 'lease_start');
  let leaseEnd = field(dateField, input.lease_end, 'lease_end');
  if (leaseStart && leaseEnd && leaseEnd < leaseStart) {
    note('lease_start', 'The lease would end before it starts.');
    note('lease_end', 'The lease would end before it starts.');
    leaseStart = null;
    leaseEnd = null;
  }

  const penalties = [];
  input.penalties.slice(0, MAX_PENALTIES).forEach((raw, i) => {
    const description = requiredText(300).safeParse(raw?.description);
    if (!description.success) {
      note(`penalties.${i}.description`, description.error.issues[0].message, 'A penalty or fee');
      return; // without a description the item means nothing: leave it out
    }
    const amount = noteField(120).safeParse(raw?.amount);
    if (!amount.success) {
      note(
        `penalties.${i}.amount`,
        amount.error.issues[0].message,
        `Amount for "${description.data.slice(0, 40)}"`,
      );
    }
    penalties.push({ description: description.data, amount: amount.success ? amount.data : null });
  });
  if (input.penalties.length > MAX_PENALTIES) {
    note(
      'penalties',
      `More than ${MAX_PENALTIES} items; extra ones left out.`,
      'Some penalties and fees',
    );
  }

  const flaggedClauses = [];
  input.flagged_clauses.slice(0, MAX_FLAGGED_CLAUSES).forEach((raw, i) => {
    const clause = requiredText(500).safeParse(raw?.clause);
    const reason = requiredText(300).safeParse(raw?.reason);
    if (clause.success && reason.success) {
      flaggedClauses.push({ clause: clause.data, reason: reason.data });
    } else {
      const issue = (clause.success ? reason : clause).error.issues[0];
      note(`flagged_clauses.${i}`, issue.message, 'A flagged clause');
    }
  });
  if (input.flagged_clauses.length > MAX_FLAGGED_CLAUSES) {
    note(
      'flagged_clauses',
      `More than ${MAX_FLAGGED_CLAUSES} items; extra ones left out.`,
      'Some flagged clauses',
    );
  }

  const terms = {
    monthlyRentCents: field(moneyField, input.monthly_rent, 'monthly_rent'),
    securityDepositCents: field(moneyField, input.security_deposit, 'security_deposit'),
    leaseStart,
    leaseEnd,
    utilities: costItem('utilities'),
    parking: costItem('parking'),
    subletting: {
      allowed: field(sublettingField, input.subletting.allowed, 'subletting.allowed'),
      notes: field(noteField(300), input.subletting.notes, 'subletting.notes'),
    },
    penalties,
    unreadable, // friendly names of fields that couldn't be read (shown to the student)
  };
  return { ok: true, terms, flaggedClauses, problems };
}

/** zod schema for the delete / view route param. */
export const leaseIdParams = z.object({ id: z.uuid() });
