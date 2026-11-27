/**
 * zod schemas for the admin account pages (roadmap A1).
 */
import { z } from 'zod';
import { email } from './auth.schemas.js';

/** Longest reason an admin can attach when rejecting a landlord. */
export const MAX_REASON_LENGTH = 500;

/** `/admin/landlords/:id/...` */
export const userIdParams = z.object({ id: z.uuid({ error: 'Invalid account id.' }) });

/** Reject form. The reason is optional; a blank box is saved as "no reason". */
export const rejectSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(MAX_REASON_LENGTH, {
      error: `Keep the reason to ${MAX_REASON_LENGTH} characters or fewer.`,
    })
    .optional()
    .transform((value) => value || null),
});

/** Promote form: the email of an existing, active account. */
export const promoteSchema = z.object({ email });
