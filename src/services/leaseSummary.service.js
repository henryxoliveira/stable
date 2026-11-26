/**
 * Saved lease summaries: database access + authorization, and turning a summary
 * into values for the cost estimate form.
 *
 * Authorization (query level): every query filters by `userId: user.id`, so a
 * student only ever sees or deletes their own summaries. Anyone else's summary
 * looks exactly like a missing one (404).
 */
import { prisma } from '../db/prisma.js';
import { extractLeaseTerms, LEASE_MODEL } from './leaseAi.service.js';

const FIELDS = {
  id: true,
  originalFilename: true,
  terms: true,
  flaggedClauses: true,
  model: true,
  createdAt: true,
};

/** Keep the uploaded file's name short and printable (it is shown escaped anyway). */
export function cleanFilename(name) {
  const printable = Array.from(String(name ?? ''))
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127) // drop control characters
    .join('');
  const cleaned = printable.trim().slice(0, 200);
  return cleaned || 'lease.pdf';
}

export function listMySummaries(user) {
  return prisma.leaseSummary.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    select: FIELDS,
  });
}

/** One of the student's own summaries, or null if missing / not theirs. */
export function getMySummary(user, id) {
  return prisma.leaseSummary.findFirst({ where: { id, userId: user.id }, select: FIELDS });
}

/**
 * Read the PDF with Claude, check the result, and save ONLY the checked summary.
 * The PDF itself is never stored.
 */
export async function summarizeAndSave(user, aiClient, { buffer, originalname }) {
  const { terms, flaggedClauses } = await extractLeaseTerms(aiClient, buffer);
  return prisma.leaseSummary.create({
    data: {
      userId: user.id,
      originalFilename: cleanFilename(originalname),
      terms,
      flaggedClauses,
      model: LEASE_MODEL,
    },
    select: { id: true },
  });
}

/** Delete one of the student's own summaries. False if missing / not theirs. */
export async function deleteMySummary(user, id) {
  const { count } = await prisma.leaseSummary.deleteMany({ where: { id, userId: user.id } });
  return count === 1;
}

// --- Pre-filling the cost estimate form (pure) ------------------------------

/** 125000 → "1250.00" (what the money parser accepts). */
export function centsToInput(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * Whole months covered by a lease: "2027-09-01".."2028-08-31" → 12.
 * Returns null when a date is missing or the result is outside 1–24 months
 * (the form's allowed range), so the student fills it in.
 */
export function leaseMonthsBetween(start, end) {
  if (!start || !end) return null;
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const months = (ey - sy) * 12 + (em - sm) + (ed >= sd ? 1 : 0);
  return months >= 1 && months <= 24 ? months : null;
}

/** Utilities / parking → form text: "0" if included in rent, the amount if known, else blank. */
function costItemInput(item) {
  if (item?.included === true) return '0';
  if (Number.isInteger(item?.monthlyCents)) return centsToInput(item.monthlyCents);
  return '';
}

/**
 * Values for the existing cost estimate form, from a saved summary. Anything the
 * lease didn't state is left BLANK so the student has to fill it in. Nothing is
 * saved here: the student checks the form and submits it like any other estimate.
 */
export function prefillFromLease(summary) {
  const t = summary.terms;
  const months = leaseMonthsBetween(t.leaseStart, t.leaseEnd);
  return {
    name: `Lease: ${summary.originalFilename}`.slice(0, 60),
    rent: Number.isInteger(t.monthlyRentCents) ? centsToInput(t.monthlyRentCents) : '',
    utilities: costItemInput(t.utilities),
    parking: costItemInput(t.parking),
    leaseMonths: months === null ? '' : String(months),
    people: '',
    groupId: '',
    onCampusQuarterly: '',
    quarters: '3',
  };
}
