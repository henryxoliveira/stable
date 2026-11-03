/**
 * Test-database helpers. These DELETE data, so they refuse to run outside
 * NODE_ENV=test (and config/env.js forces the test DB URL in that mode).
 */
import { prisma } from '../../src/db/prisma.js';
import { hashPassword } from '../../src/services/auth.service.js';

export async function resetDb() {
  if (process.env.NODE_ENV !== 'test') throw new Error('resetDb() may only run in tests.');
  await prisma.$executeRaw`TRUNCATE TABLE "users", "session" CASCADE`;
}

/**
 * Insert a user directly (e.g. an admin or an already-approved landlord).
 * @param {{ email: string, password?: string, role: string, status?: string }} data
 */
export async function createUser({
  email,
  password = 'correct-horse-battery',
  role,
  status = 'ACTIVE',
}) {
  return prisma.user.create({
    data: { email, passwordHash: await hashPassword(password), role, status },
  });
}

export { prisma };
