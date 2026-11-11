/**
 * zod schemas for roommate groups. Run on the server for every request.
 */
import { z } from 'zod';
import { config } from '../config/env.js';
import { email } from './auth.schemas.js';
import { upcomingTerms } from '../services/group.service.js';

/**
 * "fall-2026" → "FALL-2026". Only the terms in upcomingTerms() are accepted
 * (the current quarter + the next 5), checked at request time so the window
 * moves forward on its own. Past or far-future terms get a 400.
 */
export const term = z
  .string({ error: 'Choose a term.' })
  .trim()
  .toUpperCase()
  .superRefine((value, ctx) => {
    const allowed = upcomingTerms();
    if (!allowed.includes(value)) {
      ctx.addIssue({
        code: 'custom',
        message: `Choose one of the upcoming terms: ${allowed.join(', ')}.`,
      });
    }
  });

export const createGroupSchema = z.object({
  name: z
    .string({ error: 'Group name is required.' })
    .trim()
    .min(1, { error: 'Group name is required.' })
    .max(60, { error: 'Group name must be at most 60 characters.' }),
  term,
});

/** Invitations may only go to student-domain addresses (e.g. @scu.edu). */
export const inviteSchema = z.object({
  email: email.refine((value) => value.endsWith(`@${config.studentEmailDomain}`), {
    error: `Invitations can only be sent to @${config.studentEmailDomain} addresses.`,
  }),
});

export const transferSchema = z.object({
  newOwnerId: z.uuid({ error: 'Choose a member.' }),
});

export const groupIdParams = z.object({ id: z.uuid() });
export const groupInviteParams = z.object({ id: z.uuid(), inviteId: z.uuid() });
export const inviteIdParams = z.object({ inviteId: z.uuid() });
