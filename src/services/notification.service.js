/**
 * In-app notifications (roadmap B6 part 1). No email.
 *
 * Writing: other services call notify() with THEIR transaction (`tx`), so a
 * notification exists exactly when the event that caused it was committed. If the
 * move is refused or rolled back, its notifications disappear with it.
 *
 * Rules enforced here, in one place:
 *   - nobody is notified about their own action (the actor is removed from the list)
 *   - each person gets at most one copy of a notification
 *   - the link is an internal path: one "/" then anything but "/" or "\" (so never
 *     "//evil.example" or a full URL). The database has the same CHECK.
 *
 * Reading: every query filters on the logged-in user's id, so someone else's
 * notification looks exactly like a missing one (404).
 */
import { prisma } from '../db/prisma.js';
import { notFound } from '../utils/httpError.js';

/** Same values as the NotificationType enum in prisma/schema.prisma. */
export const NOTIFICATION_TYPES = Object.freeze({
  APPLICATION_SUBMITTED: 'APPLICATION_SUBMITTED',
  DOCUMENTS_REQUESTED: 'DOCUMENTS_REQUESTED',
  REVIEW_STARTED: 'REVIEW_STARTED',
  OFFER_MADE: 'OFFER_MADE',
  OFFER_RESCINDED: 'OFFER_RESCINDED',
  APPLICATION_REJECTED: 'APPLICATION_REJECTED',
  DOCUMENTS_SENT: 'DOCUMENTS_SENT',
  APPLICATION_WITHDRAWN: 'APPLICATION_WITHDRAWN',
  OFFER_DECLINED: 'OFFER_DECLINED',
  OFFER_ACCEPTED: 'OFFER_ACCEPTED',
  APPLICATION_CLOSED: 'APPLICATION_CLOSED',
  OFFER_EXPIRED: 'OFFER_EXPIRED',
  GROUP_INVITE: 'GROUP_INVITE',
});

/** How many notifications the page shows (newest first). */
export const PAGE_SIZE = 100;

/**
 * True for a path on this site: "/" followed by anything except a second "/" or
 * a "\" (browsers read "//x" and "/\x" as another site), with no spaces or
 * control characters. "https://..." fails because it doesn't start with "/".
 */
export function isInternalPath(link) {
  // eslint-disable-next-line no-control-regex
  return typeof link === 'string' && /^\/(?![/\\])[^\s\x00-\x1f\x7f]*$/.test(link);
}

/**
 * Write one notification for each recipient, except the actor.
 * @param {object} tx  the caller's Prisma transaction client
 * @param {{ recipientIds: (string|null|undefined)[], actorId?: string|null,
 *           type: keyof typeof NOTIFICATION_TYPES, message: string, link: string }} n
 * @returns {Promise<number>} how many were written
 */
export async function notify(tx, { recipientIds, actorId = null, type, message, link }) {
  if (!NOTIFICATION_TYPES[type]) throw new Error(`Unknown notification type: ${type}`);
  // Links are built by our own code; a bad one is a bug, so fail loudly (and roll back).
  if (!isInternalPath(link)) throw new Error(`Notification link must be an internal path.`);
  const userIds = [...new Set(recipientIds)].filter((id) => id && id !== actorId);
  if (userIds.length === 0) return 0;
  const { count } = await tx.notification.createMany({
    data: userIds.map((userId) => ({ userId, type, message, link })),
  });
  return count;
}

/** Ids of a group's accepted members (pending invitees aren't members yet). */
export async function groupMemberIds(tx, groupId) {
  const rows = await tx.groupMember.findMany({ where: { groupId }, select: { userId: true } });
  return rows.map((r) => r.userId);
}

/** Append a user's comment in quotes, e.g. ` Comment: "Need pay stubs."`. */
export function withComment(text, comment) {
  return comment ? `${text} Comment: “${comment}”` : text;
}

// ---------------------------------------------------------------------------
// Reading and marking read (always the logged-in user's own)
// ---------------------------------------------------------------------------

const PUBLIC_FIELDS = {
  id: true,
  type: true,
  message: true,
  link: true,
  readAt: true,
  createdAt: true,
};

/** My notifications, newest first, plus my unread count. */
export async function listMine(user) {
  const [notifications, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: user.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE,
      select: PUBLIC_FIELDS,
    }),
    unreadCount(user),
  ]);
  return { notifications, unread };
}

/** For the header badge. */
export function unreadCount(user) {
  return prisma.notification.count({ where: { userId: user.id, readAt: null } });
}

/**
 * Mark one of MY notifications read. Someone else's (or a missing one) is 404.
 * Marking an already-read one again is fine and keeps the first read time.
 */
export async function markRead(user, id, now = new Date()) {
  const own = await prisma.notification.findFirst({
    where: { id, userId: user.id },
    select: PUBLIC_FIELDS,
  });
  if (!own) throw notFound();
  if (own.readAt) return own;
  return prisma.notification.update({
    where: { id: own.id },
    data: { readAt: now },
    select: PUBLIC_FIELDS,
  });
}

/** Mark all of MY unread notifications read. Returns how many changed. */
export async function markAllRead(user, now = new Date()) {
  const { count } = await prisma.notification.updateMany({
    where: { userId: user.id, readAt: null },
    data: { readAt: now },
  });
  return count;
}
