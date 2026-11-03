/**
 * The bootstrap admin script is idempotent and never overwrites anyone.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { seedAdmin } from '../scripts/seed-admin.js';
import { createUser, prisma, resetDb } from './helpers/db.js';
import { login, newAgent } from './helpers/http.js';

beforeEach(resetDb);

const input = { email: 'Housing@SCU.edu', password: 'a-long-admin-password' };

describe('seed:admin', () => {
  it('creates the first admin, who can then log in', async () => {
    expect((await seedAdmin(input)).status).toBe('created');
    const admin = await prisma.user.findUnique({ where: { email: 'housing@scu.edu' } });
    expect(admin).toMatchObject({ role: 'ADMIN', status: 'ACTIVE' });

    const agent = newAgent();
    await login(agent, 'housing@scu.edu', input.password);
    expect((await agent.get('/dashboard/admin')).status).toBe(200);
  });

  it('is idempotent: a second run changes nothing (not even the password)', async () => {
    await seedAdmin(input);
    const before = await prisma.user.findUnique({ where: { email: 'housing@scu.edu' } });

    const second = await seedAdmin({ ...input, password: 'a-different-password' });
    expect(second.status).toBe('exists');

    const after = await prisma.user.findUnique({ where: { email: 'housing@scu.edu' } });
    expect(await prisma.user.count()).toBe(1);
    expect(after.passwordHash).toBe(before.passwordHash);
  });

  it('does not promote an existing non-admin user with the same email', async () => {
    await createUser({ email: 'housing@scu.edu', role: 'STUDENT' });
    expect((await seedAdmin(input)).status).toBe('conflict');
    const user = await prisma.user.findUnique({ where: { email: 'housing@scu.edu' } });
    expect(user.role).toBe('STUDENT');
  });

  it('rejects a missing or weak password', async () => {
    await expect(seedAdmin({ email: 'housing@scu.edu' })).rejects.toThrow();
    await expect(seedAdmin({ email: 'housing@scu.edu', password: 'short' })).rejects.toThrow();
    expect(await prisma.user.count()).toBe(0);
  });
});
