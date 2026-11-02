/**
 * Business logic for accounts: hashing, registration, credential checks.
 * No Express objects here, so it is easy to unit-test and reuse from scripts.
 */
import argon2 from 'argon2';
import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { conflict, forbidden } from '../utils/httpError.js';
import { PUBLIC_ROLES } from '../validation/auth.schemas.js';

/** argon2id with library defaults (memory-hard, recommended by OWASP). */
export function hashPassword(password) {
  return argon2.hash(password, { type: argon2.argon2id });
}

export function verifyPassword(hash, password) {
  return argon2.verify(hash, password);
}

// Used when the email doesn't exist, so "unknown email" and "wrong password"
// take about the same time (prevents discovering accounts by timing).
const dummyHashPromise = hashPassword('not-a-real-password-just-for-timing');

/**
 * Create a STUDENT (ACTIVE) or LANDLORD (PENDING) account.
 * @param {{ email: string, password: string, role: 'STUDENT'|'LANDLORD' }} input  already validated
 * @returns {Promise<{ id: string, email: string, role: string, status: string }>}
 */
export async function registerUser({ email, password, role }) {
  // Defense in depth: the zod schema already rejects these, but this function
  // must never be able to create an admin no matter who calls it.
  if (!PUBLIC_ROLES.includes(role)) throw forbidden('That role cannot self-register.');
  if (role === 'STUDENT' && !email.endsWith(`@${config.studentEmailDomain}`)) {
    throw forbidden(`Students must use an @${config.studentEmailDomain} email.`);
  }

  const status = role === 'LANDLORD' ? 'PENDING' : 'ACTIVE';
  try {
    return await prisma.user.create({
      data: { email, passwordHash: await hashPassword(password), role, status },
      select: { id: true, email: true, role: true, status: true },
    });
  } catch (err) {
    if (err.code === 'P2002')
      throw conflict('An account with this email already exists.', 'EMAIL_TAKEN');
    throw err;
  }
}

/**
 * Check credentials. Returns the user on success, or null on any failure
 * (unknown email, wrong password, suspended) so callers show one generic message.
 * @param {string} email  normalized (trimmed, lowercased)
 * @param {string} password
 */
export async function authenticate(email, password) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    await verifyPassword(await dummyHashPromise, password);
    return null;
  }
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok || user.status === 'SUSPENDED') return null;
  return { id: user.id, email: user.email, role: user.role, status: user.status };
}
