/**
 * Admin account decisions (roadmap A1): approve or reject pending landlords,
 * and promote an existing account to admin.
 *
 * Callers must already be admins (`requireRole('ADMIN')` on every route).
 * Admins may see every account, so "no such account" is a plain 404 here.
 *
 * Every change runs in ONE transaction:
 *   1. a conditional UPDATE (`WHERE status = 'PENDING'` etc.), so two admins
 *      clicking at the same time can't both win: Postgres re-checks the WHERE
 *      after the first one commits, and the second update matches 0 rows;
 *   2. an `account_events` row recording who did it, to whom, and why.
 * The change applies right away: `loadUser` re-reads the user every request.
 */
import { prisma } from '../db/prisma.js';
import { conflict, notFound } from '../utils/httpError.js';

/** Safe fields to return (never the password hash). */
const USER_FIELDS = { id: true, email: true, role: true, status: true, createdAt: true };

/** Landlords waiting for a decision, oldest first (first come, first served). */
export function listPendingLandlords() {
  return prisma.user.findMany({
    where: { role: 'LANDLORD', status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    select: USER_FIELDS,
  });
}

/** How many landlords are waiting (shown on the admin dashboard). */
export function countPendingLandlords() {
  return prisma.user.count({ where: { role: 'LANDLORD', status: 'PENDING' } });
}

/**
 * The latest admin decisions, newest first, with both people's emails.
 * @param {number} [take]
 */
export function listRecentAccountEvents(take = 20) {
  return prisma.accountEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      type: true,
      comment: true,
      detail: true,
      createdAt: true,
      actor: { select: { email: true } },
      target: { select: { email: true } },
    },
  });
}

/**
 * Move a PENDING landlord to `status` and log it.
 * 404 if the id isn't a landlord; 409 if someone already decided.
 */
async function decideLandlord(admin, landlordId, { status, type, comment = null }) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: landlordId, role: 'LANDLORD', status: 'PENDING' },
      data: { status },
    });
    if (count === 0) {
      const existing = await tx.user.findUnique({
        where: { id: landlordId },
        select: { role: true, status: true },
      });
      if (!existing || existing.role !== 'LANDLORD') throw notFound('No landlord with that id.');
      throw conflict(
        `This landlord is already ${existing.status.toLowerCase()}, so there is nothing to decide.`,
        'NOT_PENDING',
      );
    }
    await tx.accountEvent.create({
      data: { actorId: admin.id, targetUserId: landlordId, type, comment },
    });
    return tx.user.findUnique({ where: { id: landlordId }, select: USER_FIELDS });
  });
}

/** PENDING landlord → ACTIVE (can publish listings). */
export function approveLandlord(admin, landlordId) {
  return decideLandlord(admin, landlordId, { status: 'ACTIVE', type: 'LANDLORD_APPROVED' });
}

/**
 * PENDING landlord → REJECTED. They can no longer log in, and any session
 * they have is dropped on their next request.
 * @param {string|null} reason  optional, saved on the audit row
 */
export function rejectLandlord(admin, landlordId, reason) {
  return decideLandlord(admin, landlordId, {
    status: 'REJECTED',
    type: 'LANDLORD_REJECTED',
    comment: reason,
  });
}

/**
 * Make an existing ACTIVE student or landlord an admin.
 * 404 unknown email; 409 already an admin, the account isn't active
 * (approve a pending landlord first; suspended/rejected accounts stay out),
 * or the student is in an active roommate group. Admins get 403 on every
 * group action, so a promoted member could never leave, invite, or hand
 * off ownership, and a group they own would be stuck.
 * @param {{ id: string }} admin
 * @param {string} email  already trimmed and lowercased by zod
 */
export async function promoteToAdmin(admin, email) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email }, select: USER_FIELDS });
    if (!user) throw notFound('No account with that email.');
    if (user.role === 'ADMIN') throw conflict('That account is already an admin.', 'ALREADY_ADMIN');
    if (user.status !== 'ACTIVE') {
      throw conflict(
        `Only active accounts can be promoted. This one is ${user.status.toLowerCase()}.`,
        'ACCOUNT_NOT_ACTIVE',
      );
    }

    // Lock the user's row first: joining or creating a group locks the same
    // row (group.service.js), so a student can't join a group between this
    // check and the update below.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
    const membership = await tx.groupMember.findFirst({
      where: { userId: user.id, group: { status: 'ACTIVE' } },
      select: { group: { select: { name: true, term: true } } },
    });
    if (membership) {
      const { name, term } = membership.group;
      throw conflict(
        `This student is in the roommate group "${name}" (${term}). They need to leave it or hand it off before they can be promoted.`,
        'IN_ROOMMATE_GROUP',
      );
    }

    // Same guard as above: only promote if nothing changed since we read it.
    const { count } = await tx.user.updateMany({
      where: { id: user.id, role: user.role, status: 'ACTIVE' },
      data: { role: 'ADMIN' },
    });
    if (count === 0) throw conflict('That account just changed. Reload and try again.');

    await tx.accountEvent.create({
      data: {
        actorId: admin.id,
        targetUserId: user.id,
        type: 'PROMOTED_TO_ADMIN',
        detail: { fromRole: user.role },
      },
    });
    return { ...user, role: 'ADMIN' };
  });
}
