/**
 * Group application workflow RULES (roadmap B3, part 1).
 *
 * PURE: no database, no Express, no clock. Callers pass "now" in, so every rule
 * can be tested with fixed dates. The database, routes, and pages arrive in a
 * later PR and must ask this module before changing an application's status.
 *
 * The states and moves match the "C. Group application → offer" diagram in
 * README.md exactly (a test reads the diagram and compares it with TRANSITIONS).
 */

/** Application statuses. UPPERCASE to match the other database enums. */
export const STATES = Object.freeze({
  SUBMITTED: 'SUBMITTED',
  DOCS_REQUESTED: 'DOCS_REQUESTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  OFFERED: 'OFFERED',
  ACCEPTED: 'ACCEPTED',
  DECLINED: 'DECLINED',
  EXPIRED: 'EXPIRED',
  REJECTED: 'REJECTED',
  WITHDRAWN: 'WITHDRAWN',
});

/** Friendly text for pages, e.g. DOCS_REQUESTED → "Documents requested". */
export const STATE_LABELS = Object.freeze({
  SUBMITTED: 'Submitted',
  DOCS_REQUESTED: 'Documents requested',
  UNDER_REVIEW: 'Under review',
  OFFERED: 'Offer made',
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  EXPIRED: 'Offer expired',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
});

/** Once an application reaches one of these, nothing can change it. */
export const FINAL_STATES = Object.freeze([
  STATES.ACCEPTED,
  STATES.DECLINED,
  STATES.EXPIRED,
  STATES.REJECTED,
  STATES.WITHDRAWN,
]);

/** Who is acting. The service decides which one the logged-in user is. */
export const ACTORS = Object.freeze({
  GROUP_MEMBER: 'GROUP_MEMBER', // an accepted member of the applying group
  LISTING_OWNER: 'LISTING_OWNER', // the landlord (or sublease poster) who owns the listing
  SYSTEM: 'SYSTEM', // the app itself, e.g. when an offer's deadline passes
});

const ACTOR_LABELS = {
  GROUP_MEMBER: 'a member of the applying group',
  LISTING_OWNER: 'the listing owner',
  SYSTEM: 'the system (when the deadline passes)',
};

const S = STATES;
const A = ACTORS;

/**
 * Every allowed move. `from: null` means "no application yet" (applying).
 * Each move has exactly one actor who may make it.
 */
export const TRANSITIONS = Object.freeze(
  [
    { from: null, to: S.SUBMITTED, actor: A.GROUP_MEMBER, action: 'submit' },
    { from: S.DOCS_REQUESTED, to: S.SUBMITTED, actor: A.GROUP_MEMBER, action: 'upload documents' },
    { from: S.OFFERED, to: S.ACCEPTED, actor: A.GROUP_MEMBER, action: 'accept' },
    { from: S.OFFERED, to: S.DECLINED, actor: A.GROUP_MEMBER, action: 'decline' },
    { from: S.SUBMITTED, to: S.WITHDRAWN, actor: A.GROUP_MEMBER, action: 'withdraw' },
    { from: S.DOCS_REQUESTED, to: S.WITHDRAWN, actor: A.GROUP_MEMBER, action: 'withdraw' },
    { from: S.UNDER_REVIEW, to: S.WITHDRAWN, actor: A.GROUP_MEMBER, action: 'withdraw' },

    {
      from: S.SUBMITTED,
      to: S.DOCS_REQUESTED,
      actor: A.LISTING_OWNER,
      action: 'request documents',
    },
    { from: S.SUBMITTED, to: S.UNDER_REVIEW, actor: A.LISTING_OWNER, action: 'start review' },
    { from: S.UNDER_REVIEW, to: S.OFFERED, actor: A.LISTING_OWNER, action: 'make offer' },
    { from: S.OFFERED, to: S.UNDER_REVIEW, actor: A.LISTING_OWNER, action: 'rescind offer' },
    { from: S.SUBMITTED, to: S.REJECTED, actor: A.LISTING_OWNER, action: 'reject' },
    { from: S.DOCS_REQUESTED, to: S.REJECTED, actor: A.LISTING_OWNER, action: 'reject' },
    { from: S.UNDER_REVIEW, to: S.REJECTED, actor: A.LISTING_OWNER, action: 'reject' },

    { from: S.OFFERED, to: S.EXPIRED, actor: A.SYSTEM, action: 'expire offer' },
  ].map(Object.freeze),
);

/** Moves whose answer depends on the offer deadline, so they REQUIRE { offerExpiresAt, now }. */
const DEADLINE_ACTIONS = new Set(['accept', 'expire offer']);

/**
 * Each action as a full phrase for messages ("Only the listing owner can make an offer.").
 * `action` stays short because code and pages use it as an identifier.
 */
const ACTION_PHRASES = Object.freeze({
  submit: 'submit an application',
  'upload documents': 'upload the requested documents',
  accept: 'accept an offer',
  decline: 'decline an offer',
  withdraw: 'withdraw an application',
  'request documents': 'request documents',
  'start review': 'start a review',
  'make offer': 'make an offer',
  'rescind offer': 'rescind an offer',
  reject: 'reject an application',
  'expire offer': 'expire an offer',
});

/** Readable name for a state in messages ("no application yet" for null). */
const describe = (state) => (state === null ? 'no application yet' : STATE_LABELS[state]);

const refuse = (code, reason) => ({ allowed: false, code, reason });

/** A real Date object holding a real time (not a string, not `new Date('nope')`). */
const isValidDate = (value) => value instanceof Date && !Number.isNaN(value.getTime());

export function isFinal(state) {
  return FINAL_STATES.includes(state);
}

/**
 * True once the deadline has been reached. At EXACTLY the deadline the offer is
 * expired, because the group must accept BEFORE the deadline.
 * @param {Date} offerExpiresAt
 * @param {Date} now  passed in by the caller; this module never reads the clock
 */
export function isOfferExpired(offerExpiresAt, now) {
  for (const [name, value] of [
    ['offerExpiresAt', offerExpiresAt],
    ['now', now],
  ]) {
    if (!isValidDate(value)) throw new TypeError(`${name} must be a valid Date.`);
  }
  return now.getTime() >= offerExpiresAt.getTime();
}

/**
 * May `actor` move an application from `from` to `to`?
 *
 * Returns `{ allowed: true, action }`, or `{ allowed: false, code, reason }` with a
 * plain-English reason. Codes, checked in this order:
 *   UNKNOWN_STATE / UNKNOWN_ACTOR   a programming mistake
 *   FINAL_STATE                     the application is finished
 *   ILLEGAL_TRANSITION              no such move in the workflow
 *   WRONG_ACTOR                     the move exists, but someone else must make it
 *   MISSING_DEADLINE                "accept" / "expire offer" without a valid { offerExpiresAt, now }
 *                                   (missing, or not real Date objects, e.g. an ISO string from JSON)
 *   OFFER_EXPIRED                   accepting at or after the deadline
 *   OFFER_NOT_EXPIRED               expiring before the deadline
 * Later, the service maps WRONG_ACTOR to 403 and every other refusal to 409.
 *
 * @param {string|null} from  current status, or null when applying
 * @param {string} to
 * @param {string} actor  one of ACTORS
 * @param {{ offerExpiresAt: Date, now: Date }} [context]  required for accept / expire offer
 */
export function canTransition(from, to, actor, context) {
  // Object.hasOwn, not `in`: `in` would also accept inherited names like "toString".
  if ((from !== null && !Object.hasOwn(STATES, from)) || !Object.hasOwn(STATES, to)) {
    return refuse('UNKNOWN_STATE', `Unknown application status: ${from} → ${to}.`);
  }
  if (!Object.hasOwn(ACTORS, actor)) return refuse('UNKNOWN_ACTOR', `Unknown actor: ${actor}.`);

  if (isFinal(from)) {
    return refuse(
      'FINAL_STATE',
      `This application is ${STATE_LABELS[from].toLowerCase()}, so it can't change any more.`,
    );
  }

  const move = TRANSITIONS.find((t) => t.from === from && t.to === to);
  if (!move) {
    return refuse(
      'ILLEGAL_TRANSITION',
      `An application can't go from "${describe(from)}" to "${describe(to)}".`,
    );
  }
  if (move.actor !== actor) {
    return refuse(
      'WRONG_ACTOR',
      `Only ${ACTOR_LABELS[move.actor]} can ${ACTION_PHRASES[move.action]}.`,
    );
  }

  if (DEADLINE_ACTIONS.has(move.action)) {
    const { offerExpiresAt, now } = context ?? {};
    // Refuse (never throw) when either date is missing OR not a real Date, e.g. an ISO
    // string from a JSON body. A throw here would surface as a 500 instead of a 409.
    if (!isValidDate(offerExpiresAt) || !isValidDate(now)) {
      return refuse(
        'MISSING_DEADLINE',
        `To ${ACTION_PHRASES[move.action]}, the offer deadline and the current time must both be valid dates.`,
      );
    }
    const expired = isOfferExpired(offerExpiresAt, now); // safe: both checked above
    if (move.action === 'accept' && expired) {
      return refuse('OFFER_EXPIRED', 'This offer has expired, so it can no longer be accepted.');
    }
    if (move.action === 'expire offer' && !expired) {
      return refuse('OFFER_NOT_EXPIRED', "This offer's deadline hasn't passed yet.");
    }
  }

  return { allowed: true, action: move.action };
}

/**
 * The moves `actor` could make from `from` (ignoring deadlines). Pages use this
 * to decide which buttons to show.
 * @returns {{ to: string, action: string }[]}
 */
export function allowedMoves(from, actor) {
  return TRANSITIONS.filter((t) => t.from === from && t.actor === actor).map(({ to, action }) => ({
    to,
    action,
  }));
}

/**
 * Does a group of `groupSize` people fit the unit? Capacity is the number of
 * beds; if beds isn't set, the number of bedrooms.
 * @param {number} groupSize  accepted members of the group
 * @param {{ beds?: number|null, bedrooms?: number|null }} unit
 * @returns {{ ok: true, capacity: number } | { ok: false, reason: string }}
 */
export function groupFitsUnit(groupSize, unit) {
  if (!Number.isInteger(groupSize) || groupSize < 1) {
    return { ok: false, reason: 'The group must have at least one member.' };
  }
  const capacity = unit?.beds ?? unit?.bedrooms;
  if (!Number.isInteger(capacity) || capacity < 1) {
    return { ok: false, reason: "This unit doesn't list how many people it fits." };
  }
  if (groupSize > capacity) {
    return {
      ok: false,
      reason: `This unit fits ${capacity} ${capacity === 1 ? 'person' : 'people'}, but the group has ${groupSize}.`,
    };
  }
  return { ok: true, capacity };
}
