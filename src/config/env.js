/**
 * Central, validated configuration.
 *
 * Every environment variable the app reads is parsed HERE and nowhere else, so
 * there is exactly one place to look to see what the app needs. Locally the
 * values come from `.env` (gitignored); on Cloud Run they come from service
 * environment variables / Secret Manager.
 */
import 'dotenv/config';
import { z } from 'zod';

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_URL_TEST: z.string().optional(),
  // Sessions are signed with this. Must be long and random in production.
  SESSION_SECRET: isProduction
    ? z.string().min(32, 'SESSION_SECRET must be at least 32 characters in production')
    : z.string().default('dev-only-insecure-session-secret-change-me'),
  ALLOWED_STUDENT_EMAIL_DOMAIN: z.string().default('scu.edu'),
  GCS_BUCKET: z.string().optional(),
});

// In tests we always talk to the separate test database, never the dev/prod one.
const raw = { ...process.env };
if (isTest) {
  if (!raw.DATABASE_URL_TEST) {
    throw new Error('DATABASE_URL_TEST must be set to run tests (use a separate Neon branch).');
  }
  raw.DATABASE_URL = raw.DATABASE_URL_TEST;
}

const parsed = schema.safeParse(raw);
if (!parsed.success) {
  // Fail fast at boot with a readable message (no secret values are printed).
  const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  throw new Error(`Invalid configuration:\n${problems.join('\n')}`);
}

export const config = {
  ...parsed.data,
  isProduction,
  isTest,
  studentEmailDomain: parsed.data.ALLOWED_STUDENT_EMAIL_DOMAIN.toLowerCase(),
};
