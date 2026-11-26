/**
 * Group applications (roadmap B3 part 2): database access, authorization, locks,
 * and audit events. The RULES are not here: every status change asks canTransition()
 * in application.workflow.js, group size goes through groupFitsUnit(), readiness
 * through isReady(), and the buttons come from allowedMoves().
 *
 * Who may do what (checked in the query that loads the application):
 *   - GROUP_MEMBER: an accepted member of the application's group.
 *   - LISTING_OWNER: the landlord who owns the unit's property.
 *   - An admin can VIEW any application but never act (403).
 *   - Anyone else gets 404, so an application's existence isn't revealed.
 *
 * LOCK ORDER (prevents deadlocks; every path takes locks in this order):
 *   apply        = group row → unit row
 *   make offer   = unit row → application row
 *   accept       = group row → unit row → application row (then it updates the other
 *                  open applications it closes)
 *   other moves  = application row only
 * Nothing ever holds a later lock while waiting for an earlier one, so two
 * transactions can't wait on each other in a cycle.
 *
 * Offer expiry: whenever applications are read (and before every move), any OFFERED
 * application past its deadline becomes EXPIRED with a SYSTEM event. Exactly at the
 * deadline counts as expired (same rule as isOfferExpired()).
 *
 * Every status change writes an application_events row in the same transaction.
 */
import { prisma } from '../db/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/httpError.js';
import {
  ACTORS,
  FINAL_STATES,
  STATES,
  STATE_LABELS,
  allowedMoves,
  canTransition,
  groupFitsUnit,
} from './application.workflow.js';
import { isReady, lockGroupForApplying } from './group.service.js';

/** Longest an offer may stay open. */
export const MAX_OFFER_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_STATES = Object.values(STATES).filter((s) => !FINAL_STATES.includes(s));
const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 };

/**
 * The moves a request can ask for, by URL slug. `action` must match the action
 * canTransition() reports, so e.g. "start review" can never rescind an offer
 * (both end in UNDER_REVIEW, from different states).
 */
export const MOVES = Object.freeze({
  withdraw: {
    to: STATES.WITHDRAWN,
    actor: ACTORS.GROUP_MEMBER,
    action: 'withdraw',
    label: 'Withdraw',
  },
  decline: {
    to: STATES.DECLINED,
    actor: ACTORS.GROUP_MEMBER,
    action: 'decline',
    label: 'Decline offer',
  },
  // The group says it sent the requested documents (file upload arrives with GCS, A4).
  'send-documents': {
    to: STATES.SUBMITTED,
    actor: ACTORS.GROUP_MEMBER,
    action: 'upload documents',
    label: 'Send documents',
    commentRequired: true,
  },
  'request-documents': {
    to: STATES.DOCS_REQUESTED,
    actor: ACTORS.LISTING_OWNER,
    action: 'request documents',
    label: 'Request documents',
    commentRequired: true,
  },
  'start-review': {
    to: STATES.UNDER_REVIEW,
    actor: ACTORS.LISTING_OWNER,
    action: 'start review',
    label: 'Start review',
  },
  offer: {
    to: STATES.OFFERED,
    actor: ACTORS.LISTING_OWNER,
    action: 'make offer',
    label: 'Make offer',
    needsDeadline: true,
  },
  rescind: {
    to: STATES.UNDER_REVIEW,
    actor: ACTORS.LISTING_OWNER,
    action: 'rescind offer',
    label: 'Rescind offer',
  },
  reject: { to: STATES.REJECTED, actor: ACTORS.LISTING_OWNER, action: 'reject', label: 'Reject' },
});

/** canTransition() action → URL slug (for the buttons). */
const SLUG_FOR_ACTION = Object.fromEntries(
  Object.entries(MOVES).map(([slug, m]) => [m.action, slug]),
);

/** Turn a canTransition() refusal into an HTTP error: wrong actor 403, anything else 409. */
function refusalError(result) {
  return result.code === 'WRONG_ACTOR'
    ? forbidden(result.reason, 'WRONG_ACTOR')
    : conflict(result.reason, result.code);
}

const USER_PUBLIC = { select: { id: true, email: true } };
const DETAIL_INCLUDE = {
  group: {
    select: {
      id: true,
      name: true,
      term: true,
      members: { select: { user: USER_PUBLIC }, orderBy: { joinedAt: 'asc' } },
    },
  },
  unit: {
    select: {
      id: true,
      label: true,
      beds: true,
      bedrooms: true,
      status: true,
      property: { select: { id: true, name: true, city: true, ownerId: true } },
    },
  },
  events: {
    orderBy: { createdAt: 'asc' },
    include: { actor: USER_PUBLIC },
  },
};

// ---------------------------------------------------------------------------
// Offer expiry (check-on-read)
// ---------------------------------------------------------------------------

/**
 * Expire every OFFERED application matching `where` whose deadline has passed.
 * Each one is moved by a conditional update (still OFFERED and past the deadline),
 * so two reads at the same moment can't both write the SYSTEM event.
 * @param {object} where  extra Prisma filter, e.g. { id } or { unitId }
 * @param {Date} now
 * @returns {Promise<number>} how many were expired
 */
export async function expireDueOffers(where, now = new Date()) {
  const due = await prisma.application.findMany({
    where: { ...where, status: STATES.OFFERED, offerExpiresAt: { lte: now } },
    select: { id: true, offerExpiresAt: true },
  });
  let expired = 0;
  for (const app of due) {
    const check = canTransition(STATES.OFFERED, STATES.EXPIRED, ACTORS.SYSTEM, {
      offerExpiresAt: app.offerExpiresAt,
      now,
    });
    if (!check.allowed) continue;
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.application.updateMany({
        where: { id: app.id, status: STATES.OFFERED, offerExpiresAt: { lte: now } },
        data: { status: STATES.EXPIRED },
      });
      if (count !== 1) return; // someone else already moved it
      await tx.applicationEvent.create({
        data: {
          applicationId: app.id,
          actorId: null,
          actorType: ACTORS.SYSTEM,
          fromStatus: STATES.OFFERED,
          toStatus: STATES.EXPIRED,
          comment: 'The offer deadline passed.',
        },
      });
      expired += 1;
    }, TX_OPTIONS);
  }
  return expired;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * How `user` relates to a loaded application: GROUP_MEMBER, LISTING_OWNER, or
 * 'ADMIN' (view only). Throws 404 for anyone else.
 */
async function viewerRole(db, user, app) {
  if (user.role === 'ADMIN') return 'ADMIN';
  if (user.role === 'LANDLORD' && app.unit.property.ownerId === user.id) {
    return ACTORS.LISTING_OWNER;
  }
  if (user.role === 'STUDENT') {
    const member = await db.groupMember.findUnique({
      where: { groupId_userId: { groupId: app.groupId, userId: user.id } },
    });
    if (member) return ACTORS.GROUP_MEMBER;
  }
  throw notFound();
}

/** Shape an application for pages and JSON (no internal fields). */
function present(app, role) {
  return {
    id: app.id,
    status: app.status,
    statusLabel: STATE_LABELS[app.status],
    groupSize: app.groupSize,
    offerExpiresAt: app.offerExpiresAt,
    createdAt: app.createdAt,
    group: {
      id: app.group.id,
      name: app.group.name,
      term: app.group.term,
      members: app.group.members.map((m) => m.user.email),
    },
    unit: {
      id: app.unit.id,
      label: app.unit.label,
      propertyName: app.unit.property.name,
      city: app.unit.property.city,
    },
    events: app.events.map((e) => ({
      actorType: e.actorType,
      actorEmail: e.actor?.email ?? null,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      comment: e.comment,
      createdAt: e.createdAt,
    })),
    viewer: { role, moves: role === 'ADMIN' ? [] : movesFor(app.status, role) },
  };
}

/** The buttons this actor sees now (from allowedMoves()), with what each form needs. */
export function movesFor(status, actor) {
  return allowedMoves(status, actor)
    .map((m) => {
      // "accept" has its own route (it does much more than change one status).
      if (m.action === 'accept') return { slug: 'accept', label: 'Accept offer' };
      const slug = SLUG_FOR_ACTION[m.action];
      return slug ? { slug, label: MOVES[slug].label, def: MOVES[slug] } : null;
    })
    .filter(Boolean)
    .map(({ slug, label, def = {} }) => ({
      slug,
      label,
      commentRequired: Boolean(def.commentRequired),
      needsDeadline: Boolean(def.needsDeadline),
    }));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** A unit a student may apply to: exists and its landlord is ACTIVE (404 otherwise). */
export async function getApplyableUnit(unitId) {
  // TODO(A3): require an APPROVED listing for this unit instead of an active landlord.
  const unit = await prisma.unit.findFirst({
    where: { id: unitId, property: { owner: { status: 'ACTIVE' } } },
    select: {
      id: true,
      label: true,
      beds: true,
      bedrooms: true,
      rentCents: true,
      status: true,
      property: { select: { name: true, city: true } },
    },
  });
  if (!unit) throw notFound();
  return unit;
}

/** Every application of every group the student is in (expired offers updated first). */
export async function listForStudent(user, now = new Date()) {
  const memberships = await prisma.groupMember.findMany({
    where: { userId: user.id },
    select: { groupId: true },
  });
  const groupIds = memberships.map((m) => m.groupId);
  await expireDueOffers({ groupId: { in: groupIds } }, now);
  const apps = await prisma.application.findMany({
    where: { groupId: { in: groupIds } },
    orderBy: { createdAt: 'desc' },
    include: DETAIL_INCLUDE,
  });
  return apps.map((a) => present(a, ACTORS.GROUP_MEMBER));
}

/** One application, for a group member, the unit's owner, or an admin (404 otherwise). */
export async function getForViewer(user, id, now = new Date()) {
  await expireDueOffers({ id }, now);
  const app = await prisma.application.findUnique({ where: { id }, include: DETAIL_INCLUDE });
  if (!app) throw notFound();
  return present(app, await viewerRole(prisma, user, app));
}

/** Incoming applications for one unit: its owner, or an admin (404 otherwise). */
export async function listForUnit(user, unitId, now = new Date()) {
  const unit = await prisma.unit.findUnique({
    where: { id: unitId },
    select: {
      id: true,
      label: true,
      beds: true,
      status: true,
      property: { select: { id: true, name: true, ownerId: true } },
    },
  });
  const isOwner = user.role === 'LANDLORD' && unit?.property.ownerId === user.id;
  if (!unit || !(isOwner || user.role === 'ADMIN')) throw notFound();
  await expireDueOffers({ unitId }, now);
  const apps = await prisma.application.findMany({
    where: { unitId },
    orderBy: { createdAt: 'desc' },
    include: DETAIL_INCLUDE,
  });
  const role = isOwner ? ACTORS.LISTING_OWNER : 'ADMIN';
  return { unit, applications: apps.map((a) => present(a, role)) };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function lockUnit(tx, unitId) {
  await tx.$queryRaw`SELECT id FROM units WHERE id = ${unitId}::uuid FOR UPDATE`;
}
async function lockApplication(tx, id) {
  await tx.$queryRaw`SELECT id FROM applications WHERE id = ${id}::uuid FOR UPDATE`;
}

/**
 * A group applies to a unit. One transaction, locks group → unit.
 * The group lock makes two members applying at the same moment run one after the
 * other (the second sees the first application and gets 409). The unit lock means
 * the unit can't be marked leased (B5) halfway through.
 */
export async function apply(user, unitId, groupId, now = new Date()) {
  await expireDueOffers({ groupId, unitId }, now); // a stale offer shouldn't block re-applying
  return prisma.$transaction(async (tx) => {
    const g = await lockGroupForApplying(tx, user, groupId); // 404 if not an accepted member
    await lockUnit(tx, unitId);

    // TODO(A3): require an APPROVED listing for this unit instead of an active landlord.
    const unit = await tx.unit.findFirst({
      where: { id: unitId, property: { owner: { status: 'ACTIVE' } } },
      select: { id: true, beds: true, bedrooms: true, status: true },
    });
    if (!unit) throw notFound();

    if (!isReady(g)) {
      throw conflict(
        'Your group isn’t ready yet: everyone invited must accept or be removed first.',
        'GROUP_NOT_READY',
      );
    }
    const fit = groupFitsUnit(g.memberCount, unit);
    if (!fit.ok) throw conflict(fit.reason, 'GROUP_TOO_BIG');
    if (unit.status !== 'AVAILABLE') {
      throw conflict('This unit isn’t available any more.', 'UNIT_NOT_AVAILABLE');
    }
    // A group that already accepted a place can't apply anywhere else (accept also
    // locks the group first, so the two can't interleave).
    const placed = await tx.application.findFirst({
      where: { groupId, status: STATES.ACCEPTED },
      select: { id: true },
    });
    if (placed) {
      throw conflict('Your group has already accepted a place.', 'GROUP_ALREADY_PLACED');
    }
    const open = await tx.application.findFirst({
      where: { groupId, unitId, status: { in: OPEN_STATES } },
      select: { id: true },
    });
    if (open) {
      throw conflict(
        'Your group already has an open application for this unit.',
        'ALREADY_APPLIED',
      );
    }

    const check = canTransition(null, STATES.SUBMITTED, ACTORS.GROUP_MEMBER);
    if (!check.allowed) throw refusalError(check);

    const app = await tx.application.create({
      data: { groupId, unitId, status: STATES.SUBMITTED, groupSize: g.memberCount },
    });
    await tx.applicationEvent.create({
      data: {
        applicationId: app.id,
        actorId: user.id,
        actorType: ACTORS.GROUP_MEMBER,
        fromStatus: null,
        toStatus: STATES.SUBMITTED,
      },
    });
    return { id: app.id, status: app.status, unitId, groupId };
  }, TX_OPTIONS);
}

/** Work out an offer deadline from { offerExpiresAt } or { offerDays }, checked against `now`. */
export function offerDeadline({ offerExpiresAt, offerDays }, now) {
  const deadline = offerExpiresAt
    ? new Date(offerExpiresAt)
    : new Date(now.getTime() + offerDays * DAY_MS);
  const msg = `The offer deadline must be in the future and at most ${MAX_OFFER_DAYS} days away.`;
  if (
    deadline.getTime() <= now.getTime() ||
    deadline.getTime() > now.getTime() + MAX_OFFER_DAYS * DAY_MS
  ) {
    throw badRequest(msg, { offerExpiresAt: msg });
  }
  return deadline;
}

/**
 * Make one move on an application (withdraw, decline, send documents, request
 * documents, start review, make offer, rescind, reject).
 * @param {object} user
 * @param {string} id  application id
 * @param {keyof typeof MOVES} slug
 * @param {{ comment?: string, offerExpiresAt?: string, offerDays?: number }} input  validated by zod
 * @param {Date} [now]
 */
export async function move(user, id, slug, input = {}, now = new Date()) {
  const def = MOVES[slug];
  if (!def) throw notFound();
  if (user.role === 'ADMIN') throw forbidden('Admins can view applications but not act on them.');
  if (def.commentRequired && !input.comment) {
    throw badRequest('Add a short comment.', { comment: 'Add a short comment.' });
  }

  // Expire stale offers first, in their own transactions, so they stick even if this
  // move is then refused (e.g. declining an offer that has already expired).
  // For "make offer", expire every due offer on the WHOLE unit (like the unit's
  // applications page does): otherwise another group's offer that ran out but
  // hasn't been read since would still block the "one open offer per unit" check.
  // (Expiring is the system's own rule, so it's fine to run before the access check.)
  if (slug === 'offer') {
    const target = await prisma.application.findUnique({ where: { id }, select: { unitId: true } });
    if (target) await expireDueOffers({ unitId: target.unitId }, now);
  } else {
    await expireDueOffers({ id }, now);
  }

  return prisma.$transaction(async (tx) => {
    if (slug === 'offer') {
      // Lock order for make offer: unit → application.
      const peek = await tx.application.findUnique({ where: { id }, select: { unitId: true } });
      if (!peek) throw notFound();
      await lockUnit(tx, peek.unitId);
    }
    await lockApplication(tx, id);
    const app = await tx.application.findUnique({
      where: { id },
      include: { unit: { select: { status: true, property: { select: { ownerId: true } } } } },
    });
    if (!app) throw notFound();
    const role = await viewerRole(tx, user, app); // 404 for strangers

    const check = canTransition(app.status, def.to, role);
    if (!check.allowed) throw refusalError(check);
    if (check.action !== def.action) {
      throw conflict(
        `You can't ${def.label.toLowerCase()} while the application is "${STATE_LABELS[app.status]}".`,
        'ILLEGAL_TRANSITION',
      );
    }

    const data = { status: def.to };
    if (def.needsDeadline) {
      data.offerExpiresAt = offerDeadline(input, now);
      if (app.unit.status !== 'AVAILABLE') {
        throw conflict('This unit isn’t available any more.', 'UNIT_NOT_AVAILABLE');
      }
      // Only one open offer per unit (the unit row is locked, so this check can't race).
      const other = await tx.application.findFirst({
        where: { unitId: app.unitId, status: STATES.OFFERED, id: { not: id } },
        select: { id: true },
      });
      if (other) {
        throw conflict(
          'Another group already has an open offer for this unit. Rescind it or wait for it to end.',
          'UNIT_HAS_OPEN_OFFER',
        );
      }
    }

    const updated = await tx.application.update({ where: { id }, data });
    await tx.applicationEvent.create({
      data: {
        applicationId: id,
        actorId: user.id,
        actorType: role,
        fromStatus: app.status,
        toStatus: def.to,
        comment: input.comment ?? null,
      },
    });
    return {
      id,
      status: updated.status,
      unitId: app.unitId,
      offerExpiresAt: updated.offerExpiresAt,
    };
  }, TX_OPTIONS);
}

// ---------------------------------------------------------------------------
// Accepting an offer (B5)
// ---------------------------------------------------------------------------

export const CLOSE_REASON_UNIT_LEASED = 'This unit was leased to another group';
export const CLOSE_REASON_GROUP_PLACED = 'Your group accepted another place';

/**
 * A group member accepts an offer. ONE transaction, locks group → unit → application:
 *   - only an accepted member of the group (404 otherwise; admins and landlords 403)
 *   - canTransition(OFFERED, ACCEPTED, GROUP_MEMBER, { offerExpiresAt, now }) must allow it;
 *     past the deadline the offer is marked EXPIRED (and stays so) and the request gets 409
 *   - re-check: the group is still ready and still fits, the unit is still AVAILABLE,
 *     and its landlord is still ACTIVE
 *   - the unit becomes LEASED, the application ACCEPTED (with an event)
 *   - every other open application for the unit, and every other open application
 *     from the group, becomes CLOSED with a SYSTEM event and a plain reason.
 * Two groups can never hold the same unit: a second accept waits on the unit lock and
 * then finds it LEASED (or its own application already CLOSED).
 */
export async function accept(user, id, now = new Date()) {
  if (user.role !== 'STUDENT') {
    throw forbidden('Only a member of the applying group can accept an offer.');
  }
  // Expire first, in its own transaction, so an expired offer stays EXPIRED even
  // though this request is refused.
  await expireDueOffers({ id }, now);

  try {
    return await prisma.$transaction((tx) => acceptInTx(tx, user, id, now), TX_OPTIONS);
  } catch (err) {
    // The deadline was reached between the expiry above and the check inside the
    // transaction: record the expiry now (the transaction was rolled back).
    if (err.code === 'OFFER_EXPIRED') await expireDueOffers({ id }, now);
    throw err;
  }
}

async function acceptInTx(tx, user, id, now) {
  // groupId and unitId never change, so reading them before locking is safe.
  const peek = await tx.application.findUnique({
    where: { id },
    select: { groupId: true, unitId: true },
  });
  if (!peek) throw notFound();

  // Lock order: group → unit → application.
  const g = await lockGroupForApplying(tx, user, peek.groupId); // 404 if not an accepted member
  await lockUnit(tx, peek.unitId);
  await lockApplication(tx, id);

  const app = await tx.application.findUnique({
    where: { id },
    select: { id: true, status: true, offerExpiresAt: true, groupId: true, unitId: true },
  });
  const check = canTransition(app.status, STATES.ACCEPTED, ACTORS.GROUP_MEMBER, {
    offerExpiresAt: app.offerExpiresAt,
    now,
  });
  if (!check.allowed) throw refusalError(check);

  // Re-checks: the group may have changed since it applied (B3 TODO).
  if (!isReady(g)) {
    throw conflict(
      'Your group isn’t ready: everyone invited must accept or be removed first.',
      'GROUP_NOT_READY',
    );
  }
  const unit = await tx.unit.findUnique({
    where: { id: app.unitId },
    select: {
      id: true,
      beds: true,
      bedrooms: true,
      status: true,
      property: { select: { owner: { select: { status: true } } } },
    },
  });
  const fit = groupFitsUnit(g.memberCount, unit);
  if (!fit.ok) throw conflict(fit.reason, 'GROUP_TOO_BIG');
  if (unit.status !== 'AVAILABLE') {
    throw conflict('This unit isn’t available any more.', 'UNIT_NOT_AVAILABLE');
  }
  // TODO(A3): also require the unit's listing to still be APPROVED.
  if (unit.property.owner.status !== 'ACTIVE') {
    throw conflict('This landlord’s account isn’t active right now.', 'LANDLORD_NOT_ACTIVE');
  }

  await tx.unit.update({ where: { id: unit.id }, data: { status: 'LEASED' } });
  await tx.application.update({ where: { id }, data: { status: STATES.ACCEPTED } });
  await tx.applicationEvent.create({
    data: {
      applicationId: id,
      actorId: user.id,
      actorType: ACTORS.GROUP_MEMBER,
      fromStatus: STATES.OFFERED,
      toStatus: STATES.ACCEPTED,
    },
  });

  // Close everything else this acceptance makes impossible.
  const others = await tx.application.findMany({
    where: {
      id: { not: id },
      status: { in: OPEN_STATES },
      OR: [{ unitId: app.unitId }, { groupId: app.groupId }],
    },
    select: { id: true, status: true, unitId: true },
  });
  for (const other of others) {
    const close = canTransition(other.status, STATES.CLOSED, ACTORS.SYSTEM);
    if (!close.allowed) throw refusalError(close); // can't happen for open states; never skip silently
    await tx.application.update({ where: { id: other.id }, data: { status: STATES.CLOSED } });
    await tx.applicationEvent.create({
      data: {
        applicationId: other.id,
        actorId: null,
        actorType: ACTORS.SYSTEM,
        fromStatus: other.status,
        toStatus: STATES.CLOSED,
        comment: other.unitId === app.unitId ? CLOSE_REASON_UNIT_LEASED : CLOSE_REASON_GROUP_PLACED,
      },
    });
  }

  return { id, status: STATES.ACCEPTED, unitId: app.unitId, closed: others.length };
}
