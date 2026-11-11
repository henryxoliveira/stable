/**
 * Roommate groups: create, invite by email, accept/decline, transfer, leave.
 * No Express objects here, so everything is unit-testable.
 *
 * Authorization (query level): every function first works out the caller's
 * relationship to the group with `loadAccess()`:
 *   owner | member | invitee (pending invite to their email) | admin
 * Anyone else gets 404, so a group's existence is never revealed. Someone who
 * can see the group but may not do the action (e.g. a member inviting) gets 403.
 *
 * Every state change runs in ONE transaction that also writes a group_events row.
 *
 * LOCK ORDER (prevents deadlocks): when a transaction needs both locks it always
 * takes the acting student's `users` row FIRST, then the `roommate_groups` row.
 *   - users row: serializes everything that can change *which group a student is
 *     in for a term* (create, accept, decline, leave). Two simultaneous accepts by
 *     the same student queue up here; the second one sees the first's membership.
 *     Cancel and transfer take it too, so every two-lock path uses the same order.
 *   - group row: serializes everything that changes *one group* (invite, cancel,
 *     accept, decline, transfer, leave/disband), so e.g. a disband can't race with
 *     an accept or a new invite, and the seat count can't be exceeded. Invite only
 *     needs this lock.
 * No code path locks a group and then a user, so two transactions can never wait
 * on each other in a cycle.
 */
import { prisma } from '../db/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/httpError.js';

/** Seats = accepted members + pending invitations. */
export const MAX_GROUP_SEATS = 16;

/** SCU quarters in calendar order, with the month (0 = Jan) each one starts. */
const QUARTERS = [
  { season: 'WINTER', startMonth: 0 }, // Jan–Mar
  { season: 'SPRING', startMonth: 3 }, // Apr–Jun
  { season: 'SUMMER', startMonth: 6 }, // Jul–Aug
  { season: 'FALL', startMonth: 8 }, // Sep–Dec
];

/** How many terms a group can be created for: the current quarter + the next 5. */
const UPCOMING_TERM_COUNT = 6;

/**
 * The terms a new group may be created for: the current SCU quarter plus the
 * next 5, e.g. on 2026-11-09 → ['FALL-2026', 'WINTER-2027', …, 'WINTER-2028'].
 * The month and year are read on the campus calendar (America/Los_Angeles), so a
 * server running in UTC doesn't switch quarters early on New Year's Eve.
 * The create form's dropdown and the zod schema both use this list.
 * @param {Date} [now]
 * @returns {string[]}
 */
export function upcomingTerms(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(now);
  let year = Number(parts.find((p) => p.type === 'year').value);
  const month = Number(parts.find((p) => p.type === 'month').value) - 1; // 0-based

  // The current quarter is the last one that has already started this year.
  let index = QUARTERS.findLastIndex((q) => month >= q.startMonth);
  const terms = [];
  for (let i = 0; i < UPCOMING_TERM_COUNT; i += 1) {
    terms.push(`${QUARTERS[index].season}-${year}`);
    index += 1;
    if (index === QUARTERS.length) {
      index = 0; // after FALL comes WINTER of the next year
      year += 1;
    }
  }
  return terms;
}

/**
 * Interactive-transaction limits. Neon is a network hop away and lock waits can
 * queue, so allow more than Prisma's 5 s default before giving up.
 */
const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 };

/** Only ever select these user fields (never the password hash). */
const USER_PUBLIC = { select: { id: true, email: true } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Row lock on the student's users row (tagged template, so ids are parameters). */
async function lockUser(tx, userId) {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
}

/** Row lock on the group. Missing groups lock nothing; loadAccess() then 404s. */
async function lockGroup(tx, groupId) {
  await tx.$queryRaw`SELECT id FROM roommate_groups WHERE id = ${groupId}::uuid FOR UPDATE`;
}

/** Append an audit row. Always called inside the same transaction as the change. */
function logEvent(tx, { groupId, actorId, type, detail }) {
  return tx.groupEvent.create({ data: { groupId, actorId, type, detail } });
}

/**
 * "Ready" = at least one accepted member and nobody still pending.
 * @param {{ memberCount: number, pendingInviteCount: number }} counts
 */
export function isReady({ memberCount, pendingInviteCount }) {
  return memberCount >= 1 && pendingInviteCount === 0;
}

/**
 * Work out how `user` relates to the group, or throw 404.
 * @param {import('@prisma/client').Prisma.TransactionClient} db  prisma or a tx
 * @param {{ id: string, email: string, role: string }} user
 * @param {string} groupId
 * @returns {Promise<{ group: object, role: 'owner'|'member'|'invitee'|'admin', invite?: object }>}
 */
async function loadAccess(db, user, groupId) {
  const group = await db.roommateGroup.findUnique({ where: { id: groupId } });
  if (!group) throw notFound();
  // Admins can view any group (even disbanded ones) for oversight.
  if (user.role === 'ADMIN') return { group, role: 'admin' };
  if (group.status !== 'ACTIVE') throw notFound();

  const member = await db.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: user.id } },
  });
  if (member) return { group, role: group.ownerId === user.id ? 'owner' : 'member' };

  const invite = await db.groupInvitation.findFirst({
    where: { groupId, email: user.email, status: 'PENDING' },
  });
  if (invite) return { group, role: 'invitee', invite };

  throw notFound();
}

function requireOwner(access, action) {
  if (access.role !== 'owner') throw forbidden(`Only the group owner can ${action}.`);
}

/** Has this student already joined a group for this term? */
function findMembershipForTerm(tx, userId, term) {
  return tx.groupMember.findUnique({ where: { userId_term: { userId, term } } });
}

const alreadyInGroup = (term = 'this term') =>
  conflict(`You are already in a roommate group for ${term}.`, 'ALREADY_IN_GROUP_FOR_TERM');

/**
 * The (user_id, term) unique index on group_members is a database BACKSTOP to the
 * users-row lock: if some future code path forgets to take the lock, Postgres still
 * refuses a second membership for the same term (Prisma error P2002), and we turn
 * that into the same 409 instead of a 500.
 */
async function withTermBackstop(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.code === 'P2002') throw alreadyInGroup();
    throw err;
  }
}

/** Human-readable one-liner for the history list. */
export function describeEvent(event) {
  const who = event.actor?.email ?? 'someone';
  const d = event.detail ?? {};
  switch (event.type) {
    case 'CREATED':
      return `${who} created the group`;
    case 'INVITED':
      return `${who} invited ${d.email}`;
    case 'INVITE_CANCELLED':
      return `${who} cancelled the invitation to ${d.email}`;
    case 'INVITE_ACCEPTED':
      return `${who} accepted the invitation`;
    case 'INVITE_DECLINED':
      return `${who} declined the invitation`;
    case 'OWNERSHIP_TRANSFERRED':
      return `${who} transferred ownership to ${d.toEmail}`;
    case 'MEMBER_LEFT':
      return `${who} left the group`;
    case 'DISBANDED':
      return `${who} left as the last member, so the group was disbanded`;
    default:
      return `${who}: ${event.type}`;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The student's groups and the pending invitations sent to their email.
 * Invitations are matched by email, so they appear right after someone
 * registers or logs in, with no extra linking step.
 */
export async function listMyGroups(user) {
  const memberships = await prisma.groupMember.findMany({
    where: { userId: user.id, group: { status: 'ACTIVE' } },
    orderBy: { joinedAt: 'asc' },
    include: {
      group: {
        include: {
          _count: { select: { members: true } },
          invitations: { where: { status: 'PENDING' }, select: { id: true } },
        },
      },
    },
  });

  const invitations = await prisma.groupInvitation.findMany({
    where: { email: user.email, status: 'PENDING', group: { status: 'ACTIVE' } },
    orderBy: { createdAt: 'asc' },
    include: { group: { include: { owner: USER_PUBLIC } } },
  });

  return {
    maxSeats: MAX_GROUP_SEATS,
    groups: memberships.map(({ group }) => {
      const counts = {
        memberCount: group._count.members,
        pendingInviteCount: group.invitations.length,
      };
      return {
        id: group.id,
        name: group.name,
        term: group.term,
        isOwner: group.ownerId === user.id,
        ...counts,
        seatsUsed: counts.memberCount + counts.pendingInviteCount,
        ready: isReady(counts),
      };
    }),
    invitations: invitations.map((inv) => ({
      id: inv.id,
      createdAt: inv.createdAt,
      group: {
        id: inv.group.id,
        name: inv.group.name,
        term: inv.group.term,
        ownerEmail: inv.group.owner.email,
      },
    })),
  };
}

/**
 * Everything the group page shows. Invitees see the group and its members
 * (so they can decide), but not other people's pending emails or the history.
 */
export async function getGroupDetail(user, groupId) {
  const access = await loadAccess(prisma, user, groupId);
  const { group, role } = access;

  const members = await prisma.groupMember.findMany({
    where: { groupId },
    orderBy: { joinedAt: 'asc' },
    include: { user: USER_PUBLIC },
  });
  const pending = await prisma.groupInvitation.findMany({
    where: { groupId, status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
  });
  const owner = await prisma.user.findUnique({ where: { id: group.ownerId }, ...USER_PUBLIC });

  const counts = { memberCount: members.length, pendingInviteCount: pending.length };
  const canSeeEverything = role !== 'invitee';

  let events = [];
  if (canSeeEverything) {
    const rows = await prisma.groupEvent.findMany({
      where: { groupId },
      orderBy: { createdAt: 'asc' },
      include: { actor: USER_PUBLIC },
    });
    events = rows.map((e) => ({
      id: e.id,
      type: e.type,
      actor: e.actor,
      detail: e.detail,
      createdAt: e.createdAt,
      summary: describeEvent(e),
    }));
  }

  return {
    group: {
      id: group.id,
      name: group.name,
      term: group.term,
      status: group.status,
      owner,
      createdAt: group.createdAt,
    },
    viewer: { role, inviteId: access.invite?.id ?? null },
    members: members.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      joinedAt: m.joinedAt,
      isOwner: m.userId === group.ownerId,
    })),
    pendingInvites: canSeeEverything
      ? pending.map((p) => ({ id: p.id, email: p.email, createdAt: p.createdAt }))
      : [],
    ...counts,
    seatsUsed: counts.memberCount + counts.pendingInviteCount,
    maxSeats: MAX_GROUP_SEATS,
    ready: isReady(counts),
    events,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Create a group; the creator becomes the owner and its first accepted member. */
export async function createGroup(user, { name, term }) {
  return withTermBackstop(() =>
    prisma.$transaction(async (tx) => {
      await lockUser(tx, user.id);
      if (await findMembershipForTerm(tx, user.id, term)) throw alreadyInGroup(term);

      const group = await tx.roommateGroup.create({
        data: {
          name,
          term,
          ownerId: user.id,
          members: { create: { userId: user.id, term } },
        },
      });
      await logEvent(tx, {
        groupId: group.id,
        actorId: user.id,
        type: 'CREATED',
        detail: { name, term },
      });
      return group;
    }, TX_OPTIONS),
  );
}

/**
 * Owner invites an email address. The result never depends on whether that
 * email has an account (we never look at the users table for it), so inviting
 * cannot be used to discover who is registered.
 */
export async function inviteByEmail(user, groupId, email) {
  return prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const access = await loadAccess(tx, user, groupId);
    requireOwner(access, 'invite people');

    if (email === user.email) {
      throw badRequest('You cannot invite yourself.', { email: 'You cannot invite yourself.' });
    }
    // Only checks the group's own members, whom the owner can already see.
    const member = await tx.groupMember.findFirst({ where: { groupId, user: { email } } });
    if (member) throw conflict('That person is already a member.', 'ALREADY_MEMBER');

    const existing = await tx.groupInvitation.findUnique({
      where: { groupId_email: { groupId, email } },
    });
    if (existing?.status === 'PENDING') {
      throw conflict('That email already has a pending invitation.', 'INVITE_EXISTS');
    }

    const memberCount = await tx.groupMember.count({ where: { groupId } });
    const pendingCount = await tx.groupInvitation.count({ where: { groupId, status: 'PENDING' } });
    if (memberCount + pendingCount >= MAX_GROUP_SEATS) {
      throw conflict(`A group can have at most ${MAX_GROUP_SEATS} seats.`, 'GROUP_FULL');
    }

    // Re-inviting (after a decline, cancel, or the person leaving) reuses the row.
    const fields = { status: 'PENDING', invitedById: user.id, createdAt: new Date() };
    const invite = existing
      ? await tx.groupInvitation.update({
          where: { id: existing.id },
          data: { ...fields, respondedAt: null },
        })
      : await tx.groupInvitation.create({ data: { ...fields, groupId, email } });

    await logEvent(tx, { groupId, actorId: user.id, type: 'INVITED', detail: { email } });
    return { id: invite.id, email: invite.email, status: invite.status };
  }, TX_OPTIONS);
}

/** Owner cancels a pending invitation. */
export async function cancelInvite(user, groupId, inviteId) {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, user.id);
    await lockGroup(tx, groupId);
    const access = await loadAccess(tx, user, groupId);
    requireOwner(access, 'cancel invitations');

    const invite = await tx.groupInvitation.findFirst({ where: { id: inviteId, groupId } });
    if (!invite) throw notFound();
    if (invite.status !== 'PENDING') {
      throw conflict('That invitation is no longer pending.', 'INVITE_NOT_PENDING');
    }
    await tx.groupInvitation.update({
      where: { id: invite.id },
      data: { status: 'CANCELLED', respondedAt: new Date() },
    });
    await logEvent(tx, {
      groupId,
      actorId: user.id,
      type: 'INVITE_CANCELLED',
      detail: { email: invite.email },
    });
  }, TX_OPTIONS);
}

/**
 * Shared start of accept/decline: lock the student, find THEIR pending invite,
 * lock its group, then re-read the invite. The re-read happens after the group
 * lock so we see any cancel/disband that committed while we were waiting.
 */
async function lockOwnPendingInvite(tx, user, inviteId) {
  await lockUser(tx, user.id);
  const found = await tx.groupInvitation.findUnique({ where: { id: inviteId } });
  // Someone else's invite looks exactly like a missing one (404).
  if (!found || found.email !== user.email) throw notFound();

  await lockGroup(tx, found.groupId);
  const invite = await tx.groupInvitation.findUnique({
    where: { id: inviteId },
    include: { group: true },
  });
  if (invite.status !== 'PENDING' || invite.group.status !== 'ACTIVE') throw notFound();
  return invite;
}

/**
 * The invitee (logged in with the invited email) joins the group.
 * A student may be in at most one group per term: the users-row lock makes two
 * simultaneous accepts run one after the other, so the second sees the first
 * membership and gets 409.
 */
export async function acceptInvite(user, inviteId) {
  return withTermBackstop(() =>
    prisma.$transaction(async (tx) => {
      const invite = await lockOwnPendingInvite(tx, user, inviteId);
      const term = invite.group.term;
      if (await findMembershipForTerm(tx, user.id, term)) throw alreadyInGroup(term);

      await tx.groupMember.create({ data: { groupId: invite.groupId, userId: user.id, term } });
      await tx.groupInvitation.update({
        where: { id: invite.id },
        data: { status: 'ACCEPTED', respondedAt: new Date() },
      });
      await logEvent(tx, {
        groupId: invite.groupId,
        actorId: user.id,
        type: 'INVITE_ACCEPTED',
        detail: { email: invite.email },
      });
      return { groupId: invite.groupId };
    }, TX_OPTIONS),
  );
}

/** The invitee declines. The owner may re-invite later. */
export async function declineInvite(user, inviteId) {
  return prisma.$transaction(async (tx) => {
    const invite = await lockOwnPendingInvite(tx, user, inviteId);
    await tx.groupInvitation.update({
      where: { id: invite.id },
      data: { status: 'DECLINED', respondedAt: new Date() },
    });
    await logEvent(tx, {
      groupId: invite.groupId,
      actorId: user.id,
      type: 'INVITE_DECLINED',
      detail: { email: invite.email },
    });
  }, TX_OPTIONS);
}

/** Owner hands ownership to another accepted member. */
export async function transferOwnership(user, groupId, newOwnerId) {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, user.id);
    await lockGroup(tx, groupId);
    const access = await loadAccess(tx, user, groupId);
    requireOwner(access, 'transfer ownership');

    if (newOwnerId === user.id) {
      throw badRequest('You already own this group.', { newOwnerId: 'Choose another member.' });
    }
    const target = await tx.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: newOwnerId } },
      include: { user: USER_PUBLIC },
    });
    if (!target) {
      throw badRequest('The new owner must be an accepted member of this group.', {
        newOwnerId: 'Choose an accepted member.',
      });
    }
    await tx.roommateGroup.update({ where: { id: groupId }, data: { ownerId: newOwnerId } });
    await logEvent(tx, {
      groupId,
      actorId: user.id,
      type: 'OWNERSHIP_TRANSFERRED',
      detail: { fromUserId: user.id, toUserId: newOwnerId, toEmail: target.user.email },
    });
  }, TX_OPTIONS);
}

/**
 * Leave a group.
 *  - A non-owner member just leaves.
 *  - The owner must transfer ownership first while others remain (409).
 *  - The owner as the only member disbands the group and cancels pending invites.
 * @returns {Promise<{ disbanded: boolean }>}
 */
export async function leaveGroup(user, groupId) {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, user.id);
    await lockGroup(tx, groupId);
    const access = await loadAccess(tx, user, groupId);
    if (access.role !== 'owner' && access.role !== 'member') {
      throw forbidden('Only members can leave a group.');
    }

    const removeMe = () =>
      tx.groupMember.delete({ where: { groupId_userId: { groupId, userId: user.id } } });

    if (access.role === 'member') {
      await removeMe();
      await logEvent(tx, { groupId, actorId: user.id, type: 'MEMBER_LEFT' });
      return { disbanded: false };
    }

    const memberCount = await tx.groupMember.count({ where: { groupId } });
    if (memberCount > 1) {
      throw conflict(
        'Transfer ownership to another member before leaving.',
        'TRANSFER_OWNERSHIP_FIRST',
      );
    }
    await removeMe();
    const cancelled = await tx.groupInvitation.updateMany({
      where: { groupId, status: 'PENDING' },
      data: { status: 'CANCELLED', respondedAt: new Date() },
    });
    await tx.roommateGroup.update({ where: { id: groupId }, data: { status: 'DISBANDED' } });
    await logEvent(tx, {
      groupId,
      actorId: user.id,
      type: 'DISBANDED',
      detail: { cancelledInvites: cancelled.count },
    });
    return { disbanded: true };
  }, TX_OPTIONS);
}
