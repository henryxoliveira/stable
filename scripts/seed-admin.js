/**
 * Bootstrap the FIRST admin account. This is the only way an admin is ever
 * created outside the app (public registration cannot create admins).
 *
 *   ADMIN_EMAIL=housing@scu.edu ADMIN_PASSWORD='…' npm run seed:admin
 *
 * Idempotent: if a user with ADMIN_EMAIL already exists it changes nothing
 * (it never resets the password or role), so it is safe to run on every deploy.
 */
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { prisma } from '../src/db/prisma.js';
import { hashPassword } from '../src/services/auth.service.js';

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z
    .string()
    .min(12, { error: 'ADMIN_PASSWORD must be at least 12 characters.' })
    .max(128),
});

/**
 * @param {{ email: string, password: string }} input
 * @returns {Promise<{ status: 'created'|'exists'|'conflict', userId?: string }>}
 *   created  - new admin inserted
 *   exists   - an admin with this email already exists; nothing changed
 *   conflict - a NON-admin with this email exists; nothing changed (promote via the app)
 */
export async function seedAdmin(input) {
  const { email, password } = inputSchema.parse(input);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { status: existing.role === 'ADMIN' ? 'exists' : 'conflict', userId: existing.id };
  }
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(password), role: 'ADMIN', status: 'ACTIVE' },
  });
  return { status: 'created', userId: user.id };
}

// Run only when executed directly (`node scripts/seed-admin.js`), not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await seedAdmin({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    });
    const messages = {
      created: 'Admin account created.',
      exists: 'Admin already exists; nothing changed.',
      conflict: 'A non-admin user already has ADMIN_EMAIL; nothing changed. Use a different email.',
    };
    console.log(messages[result.status]);
    process.exitCode = result.status === 'conflict' ? 1 : 0;
  } catch (err) {
    console.error('seed:admin failed:', err.issues ?? err.message); // never prints the password
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
