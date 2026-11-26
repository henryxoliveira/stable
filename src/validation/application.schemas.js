/**
 * zod schemas for group applications. The "is this move allowed now?" rules are
 * not here (see application.workflow.js); this only checks the shape of input.
 */
import { z } from 'zod';
import { MAX_OFFER_DAYS } from '../services/application.service.js';

export const MAX_COMMENT = 500;

/** "" / spaces → undefined, so a blank optional comment is simply "no comment". */
const blankToUndefined = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const optionalComment = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .max(MAX_COMMENT, { error: `Keep the comment to ${MAX_COMMENT} characters or fewer.` })
    .optional(),
);
const requiredComment = z.preprocess(
  blankToUndefined,
  z
    .string({ error: 'Add a short comment.' })
    .trim()
    .min(1, { error: 'Add a short comment.' })
    .max(MAX_COMMENT, { error: `Keep the comment to ${MAX_COMMENT} characters or fewer.` }),
);

export const applicationIdParams = z.object({ id: z.uuid() });
export const unitIdParams = z.object({ id: z.uuid() });

export const applyBody = z.object({
  groupId: z.uuid({ error: 'Choose one of your groups.' }),
});

/** withdraw, decline, start review, rescind, reject: an optional comment / reason. */
export const optionalCommentBody = z.object({ comment: optionalComment });

/** request documents, send documents: a comment is required. */
export const requiredCommentBody = z.object({ comment: requiredComment });

/**
 * make offer: EITHER an exact ISO date-time with a time zone (JSON clients),
 * OR a number of days 1–14 (the page's dropdown). "In the future and at most
 * 14 days away" is checked against the clock in the service.
 */
export const offerBody = z
  .object({
    offerExpiresAt: z.preprocess(
      blankToUndefined,
      z.iso
        .datetime({ offset: true, error: 'Use a date and time like 2027-03-01T17:00:00-08:00.' })
        .optional(),
    ),
    offerDays: z.preprocess(
      blankToUndefined,
      z.coerce
        .number({ error: `Choose 1 to ${MAX_OFFER_DAYS} days.` })
        .int({ error: `Choose 1 to ${MAX_OFFER_DAYS} days.` })
        .min(1, { error: `Choose 1 to ${MAX_OFFER_DAYS} days.` })
        .max(MAX_OFFER_DAYS, { error: `Choose 1 to ${MAX_OFFER_DAYS} days.` })
        .optional(),
    ),
    comment: optionalComment,
  })
  .superRefine((v, ctx) => {
    if (Boolean(v.offerExpiresAt) === (v.offerDays !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['offerExpiresAt'],
        message: 'Give either a deadline or a number of days (not both).',
      });
    }
  });

/** Which body schema each move uses. */
export const MOVE_BODIES = {
  withdraw: optionalCommentBody,
  decline: optionalCommentBody,
  'send-documents': requiredCommentBody,
  'request-documents': requiredCommentBody,
  'start-review': optionalCommentBody,
  offer: offerBody,
  rescind: optionalCommentBody,
  reject: optionalCommentBody,
};
