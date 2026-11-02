/**
 * Apply all migrations to the TEST database (DATABASE_URL_TEST).
 * Used by `npm run db:test:deploy` and automatically by the test setup.
 * Refuses to run if the test URL is missing or equals DATABASE_URL, so tests
 * can never wipe the dev or production database.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';

export function migrateTestDb() {
  const testUrl = process.env.DATABASE_URL_TEST;
  if (!testUrl) throw new Error('DATABASE_URL_TEST is not set.');
  if (testUrl === process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL_TEST must point to a different database than DATABASE_URL.');
  }
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testUrl },
  });
}

if (process.argv[1]?.endsWith('migrate-test-db.js')) migrateTestDb();
