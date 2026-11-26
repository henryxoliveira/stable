/**
 * Saved cost estimates: database access + authorization. The math itself is in
 * cost.service.js (pure); results are computed on every read, never stored.
 *
 * Authorization (query level): every query filters by `userId: user.id`, so a
 * student can only ever see or delete their own estimates. Someone else's
 * estimate looks exactly like a missing one (404).
 */
import { prisma } from '../db/prisma.js';
import { badRequest, HttpError } from '../utils/httpError.js';
import { computeEstimate } from './cost.service.js';
import { requireAcceptedMembership } from './group.service.js';

/** The saved input fields (what the student typed, already in cents). */
const INPUT_FIELDS = {
  id: true,
  name: true,
  people: true,
  rentCents: true,
  utilitiesCents: true,
  parkingCents: true,
  leaseMonths: true,
  onCampusQuarterlyCents: true,
  quarters: true,
  groupId: true,
  createdAt: true,
};

/**
 * The linked group's details, but ONLY while the student is still an accepted
 * member of that active group. Otherwise `available: false` and no details.
 */
async function linkedGroupFor(user, groupId) {
  if (!groupId) return null;
  try {
    const { group, memberCount } = await requireAcceptedMembership(user, groupId);
    return { available: true, ...group, memberCount };
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return { available: false };
    throw err;
  }
}

/** The student's estimates (newest first), each with its computed results. */
export async function listMyEstimates(user) {
  const rows = await prisma.costEstimate.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    select: INPUT_FIELDS,
  });
  return rows.map((row) => ({ ...row, result: computeEstimate(row) }));
}

/** One of the student's own estimates, or null if missing / not theirs. */
export async function getMyEstimate(user, id) {
  const row = await prisma.costEstimate.findFirst({
    where: { id, userId: user.id },
    select: INPUT_FIELDS,
  });
  if (!row) return null;
  return {
    ...row,
    result: computeEstimate(row),
    linkedGroup: await linkedGroupFor(user, row.groupId),
  };
}

/**
 * Save a new estimate. If a group is linked, the student must be an accepted
 * member of it (404 otherwise), and a blank "people" defaults to its member count.
 * @param {object} user
 * @param {object} input  validated by cost.schemas.js (money already in cents)
 */
export async function createEstimate(user, input) {
  let people = input.people;
  if (input.groupId) {
    const { memberCount } = await requireAcceptedMembership(user, input.groupId);
    people ??= memberCount;
  }
  if (people === undefined) {
    throw badRequest('Enter how many people will share the cost.', {
      people: 'Enter how many people will share the cost, or link a group.',
    });
  }

  return prisma.costEstimate.create({
    data: {
      userId: user.id,
      name: input.name,
      people,
      rentCents: input.rentCents,
      utilitiesCents: input.utilitiesCents,
      parkingCents: input.parkingCents,
      leaseMonths: input.leaseMonths,
      onCampusQuarterlyCents: input.onCampusQuarterlyCents,
      quarters: input.quarters,
      groupId: input.groupId,
    },
    select: { id: true },
  });
}

/** Delete one of the student's own estimates. Returns false if missing / not theirs. */
export async function deleteEstimate(user, id) {
  const { count } = await prisma.costEstimate.deleteMany({ where: { id, userId: user.id } });
  return count === 1;
}

/**
 * Several of the student's own estimates, in the order asked. If ANY id is not
 * theirs (or doesn't exist) the result is null, so the caller returns 404 without
 * revealing which one.
 * @param {object} user
 * @param {string[]} ids  unique uuids
 */
export async function getMyEstimatesByIds(user, ids) {
  const rows = await prisma.costEstimate.findMany({
    where: { id: { in: ids }, userId: user.id },
    select: INPUT_FIELDS,
  });
  if (rows.length !== ids.length) return null;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id));
}
