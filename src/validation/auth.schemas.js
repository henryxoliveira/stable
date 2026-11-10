/**
 * zod schemas for the auth forms. These run on the SERVER for every request;
 * any HTML `required`/`pattern` attributes are only a convenience.
 */
import { z } from 'zod';
import { config } from '../config/env.js';

/** Trimmed, lowercased email. Shared with the group invite schema. */
export const email = z
  .string({ error: 'Email is required.' })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Enter a valid email address.' }).max(254));

/**
 * Public registration may only create STUDENT or LANDLORD accounts.
 * 'ADMIN' is not in the enum, so `role=ADMIN` fails validation (400).
 */
export const PUBLIC_ROLES = ['STUDENT', 'LANDLORD'];

export const registerSchema = z
  .object({
    email,
    // Max length guards against very long inputs making argon2 slow (DoS).
    password: z
      .string({ error: 'Password is required.' })
      .min(10, { error: 'Password must be at least 10 characters.' })
      .max(128, { error: 'Password must be at most 128 characters.' }),
    role: z.enum(PUBLIC_ROLES, { error: 'Choose Student or Landlord.' }),
  })
  .superRefine((data, ctx) => {
    if (data.role === 'STUDENT' && !data.email.endsWith(`@${config.studentEmailDomain}`)) {
      ctx.addIssue({
        code: 'custom',
        path: ['email'],
        message: `Students must register with an @${config.studentEmailDomain} email.`,
      });
    }
  });

export const loginSchema = z.object({
  email,
  password: z
    .string({ error: 'Password is required.' })
    .min(1, { error: 'Password is required.' })
    .max(128),
});
