/**
 * Registration, login, logout, and the rules around who may register as what.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDb } from './helpers/db.js';
import { DEFAULT_PASSWORD, login, logout, newAgent, postForm, register } from './helpers/http.js';

beforeEach(resetDb);

describe('registration', () => {
  it('registers an @scu.edu student as ACTIVE, logs them in, and hashes the password with argon2id', async () => {
    const agent = newAgent();
    const res = await register(agent, { email: 'Alice@SCU.edu', role: 'STUDENT' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard');

    const user = await prisma.user.findUnique({ where: { email: 'alice@scu.edu' } }); // lowercased
    expect(user).toMatchObject({ role: 'STUDENT', status: 'ACTIVE' });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(DEFAULT_PASSWORD);

    const me = await agent.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('alice@scu.edu');
    expect(me.body.user).not.toHaveProperty('passwordHash');
  });

  it('rejects a student email outside @scu.edu (including look-alike domains)', async () => {
    for (const email of ['bob@gmail.com', 'bob@scu.edu.evil.com', 'bob@notscu.edu']) {
      const res = await register(newAgent(), { email, role: 'STUDENT' });
      expect(res.status).toBe(400);
      expect(res.text).toContain('@scu.edu');
    }
    expect(await prisma.user.count()).toBe(0);
  });

  it('cannot create an ADMIN through public registration', async () => {
    const res = await register(newAgent(), { email: 'mallory@scu.edu', role: 'ADMIN' });
    expect(res.status).toBe(400);
    expect(await prisma.user.count({ where: { role: 'ADMIN' } })).toBe(0);
    expect(await prisma.user.count()).toBe(0);
  });

  it('registers a landlord (any email domain) as PENDING', async () => {
    const res = await register(newAgent(), { email: 'owner@example.com', role: 'LANDLORD' });
    expect(res.status).toBe(302);
    const user = await prisma.user.findUnique({ where: { email: 'owner@example.com' } });
    expect(user).toMatchObject({ role: 'LANDLORD', status: 'PENDING' });
  });

  it('rejects missing fields, a short password, and a duplicate email', async () => {
    const missing = await postForm(
      newAgent(),
      '/register',
      { role: 'STUDENT' },
      { tokenFrom: '/register' },
    );
    expect(missing.status).toBe(400);

    const short = await register(newAgent(), { email: 'carol@scu.edu', password: 'short' });
    expect(short.status).toBe(400);
    expect(short.text).toContain('at least 10 characters');

    await register(newAgent(), { email: 'dave@scu.edu' });
    const dup = await register(newAgent(), { email: 'dave@scu.edu' });
    expect(dup.status).toBe(409);
    expect(await prisma.user.count()).toBe(1);
  });

  it('rejects a form post without a CSRF token', async () => {
    const res = await newAgent()
      .post('/register')
      .type('form')
      .send({ email: 'eve@scu.edu', password: DEFAULT_PASSWORD, role: 'STUDENT' });
    expect(res.status).toBe(403);
    expect(await prisma.user.count()).toBe(0);
  });
});

describe('login and logout', () => {
  beforeEach(async () => {
    await register(newAgent(), { email: 'frank@scu.edu' });
  });

  it('logs in with correct credentials and gets a new session id (no fixation)', async () => {
    const agent = newAgent();
    // Visiting /login creates a pre-login session (for the CSRF token).
    const before = (await agent.get('/login')).headers['set-cookie']?.[0];
    const res = await login(agent, 'frank@scu.edu');
    expect(res.status).toBe(302);
    const after = res.headers['set-cookie']?.[0];
    expect(after).toBeDefined();
    expect(after.split(';')[0]).not.toBe(before?.split(';')[0]);
    expect(after).toMatch(/HttpOnly/i);
    expect(after).toMatch(/SameSite=Lax/i);
    expect((await agent.get('/api/me')).status).toBe(200);
  });

  it('gives the same generic error for a wrong password and an unknown email', async () => {
    const wrong = await login(newAgent(), 'frank@scu.edu', 'not-the-password');
    const unknown = await login(newAgent(), 'nobody@scu.edu', 'not-the-password');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.text).toContain('Invalid email or password.');
    expect(unknown.text).toContain('Invalid email or password.');
  });

  it('logout destroys the session on the server: the old cookie no longer works', async () => {
    const agent = newAgent();
    const res = await login(agent, 'frank@scu.edu');
    const oldCookie = res.headers['set-cookie'][0].split(';')[0]; // "stable.sid=s%3A<sid>.<signature>"
    const sid = decodeURIComponent(oldCookie.split('=')[1]).slice(2).split('.')[0];
    expect(await prisma.session.findUnique({ where: { sid } })).not.toBeNull();

    const out = await logout(agent);
    expect(out.status).toBe(302);
    expect(out.headers.location).toBe('/login');
    expect(out.headers['set-cookie'][0]).toMatch(/stable\.sid=;/); // cookie cleared in the browser

    // The row is gone from Postgres...
    expect(await prisma.session.findUnique({ where: { sid } })).toBeNull();
    // ...so replaying the old cookie (e.g. a stolen copy) is rejected.
    const replay = await newAgent().get('/api/me').set('Cookie', oldCookie);
    expect(replay.status).toBe(401);
  });

  it('a suspended user cannot log in, and an existing session stops working', async () => {
    const agent = newAgent();
    await login(agent, 'frank@scu.edu');
    await prisma.user.update({ where: { email: 'frank@scu.edu' }, data: { status: 'SUSPENDED' } });
    expect((await agent.get('/api/me')).status).toBe(401);
    expect((await login(newAgent(), 'frank@scu.edu')).status).toBe(401);
  });
});
