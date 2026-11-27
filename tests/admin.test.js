/**
 * Admin accounts (A1): approve or reject pending landlords, promote to admin.
 * Multi-account workflows, authorization (403 for non-admins), concurrency
 * (two admins deciding at once), invalid input, and the audit trail.
 * Each newAgent() is a separate browser, i.e. a separate person.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, prisma, resetDb } from './helpers/db.js';
import { getCsrfToken, login, newAgent, postForm, postJson, register } from './helpers/http.js';
import { MAX_REASON_LENGTH } from '../src/validation/admin.schemas.js';
import { upcomingTerms } from '../src/services/group.service.js';

beforeEach(resetDb);

const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const ADMIN_PAGE = '/admin/accounts';

// --- helpers -----------------------------------------------------------------

/** Create an admin directly (like seed:admin) and return their logged-in agent. */
async function adminAgent(email = 'admin@scu.edu') {
  await createUser({ email, role: 'ADMIN' });
  const agent = newAgent();
  expect((await login(agent, email)).status).toBe(302);
  return agent;
}

/** Register through the real form and return the logged-in agent. */
async function registered(email, role) {
  const agent = newAgent();
  expect((await register(agent, { email, role })).status).toBe(302);
  return agent;
}

const userByEmail = (email) => prisma.user.findUnique({ where: { email } });
const idOf = async (email) => (await userByEmail(email)).id;

/** JSON POST as an admin (CSRF token taken from the admin page). */
const adminPost = (agent, path, body) => postJson(agent, path, body, { tokenFrom: ADMIN_PAGE });

const approve = async (agent, email) =>
  adminPost(agent, `/admin/landlords/${await idOf(email)}/approve`);
const reject = async (agent, email, reason) =>
  adminPost(agent, `/admin/landlords/${await idOf(email)}/reject`, { reason });

const events = () =>
  prisma.accountEvent.findMany({
    orderBy: { createdAt: 'asc' },
    include: { actor: true, target: true },
  });

// Roommate group helpers (student side; CSRF token from /groups).
const [TERM] = upcomingTerms();
async function createGroup(owner, name = 'Hilltop House') {
  const res = await postJson(owner, '/groups', { name, term: TERM });
  expect(res.status).toBe(201);
  return res.body.group.id;
}
async function inviteAndGetId(owner, groupId, invitee, email) {
  expect((await postJson(owner, `/groups/${groupId}/invites`, { email })).status).toBe(201);
  return (await invitee.get('/api/groups')).body.invitations[0].id;
}

/** Try the listing-submit route: 403 ACCOUNT_PENDING until approved, then 501 (stub). */
async function trySubmitListing(landlord) {
  const token = await getCsrfToken(landlord, '/dashboard/landlord');
  return landlord.post(`/api/listings/${MISSING_ID}/submit`).set('x-csrf-token', token);
}

// --- approving and rejecting -----------------------------------------------------

describe('pending landlords', () => {
  it('admin sees the pending landlord, approves them, and they can publish without logging in again', async () => {
    const admin = await adminAgent();
    const lena = await registered('lena@example.com', 'LANDLORD');
    await registered('sam@scu.edu', 'STUDENT'); // students never show up in the queue

    expect((await trySubmitListing(lena)).body.error.code).toBe('ACCOUNT_PENDING');

    const page = await admin.get(ADMIN_PAGE);
    expect(page.status).toBe(200);
    expect(page.text).toContain('lena@example.com');
    expect(page.text).not.toContain('sam@scu.edu');
    expect((await admin.get('/dashboard/admin')).text).toContain('1 landlord waiting');

    const api = await admin.get('/api/admin/landlords/pending');
    expect(api.body.landlords.map((l) => l.email)).toEqual(['lena@example.com']);
    expect(api.body.landlords[0]).not.toHaveProperty('passwordHash');

    // Browser form: redirect back to the accounts page.
    const res = await postForm(
      admin,
      `/admin/landlords/${await idOf('lena@example.com')}/approve`,
      {},
      { tokenFrom: ADMIN_PAGE },
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(ADMIN_PAGE);

    expect((await userByEmail('lena@example.com')).status).toBe('ACTIVE');
    expect((await trySubmitListing(lena)).status).toBe(501); // same session, now past the check
    expect((await admin.get('/api/admin/landlords/pending')).body.landlords).toEqual([]);

    const [event] = await events();
    expect(event).toMatchObject({ type: 'LANDLORD_APPROVED', comment: null });
    expect(event.actor.email).toBe('admin@scu.edu');
    expect(event.target.email).toBe('lena@example.com');
    expect((await admin.get(ADMIN_PAGE)).text).toContain('approved landlord');
  });

  it('rejecting with a reason logs the landlord out and blocks future logins', async () => {
    const admin = await adminAgent();
    const rex = await registered('rex@example.com', 'LANDLORD');
    expect((await rex.get('/api/me')).status).toBe(200);

    const res = await reject(admin, 'rex@example.com', '  Could not verify the property.  ');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'rex@example.com', status: 'REJECTED' });

    expect((await rex.get('/api/me')).status).toBe(401); // session dropped on the next request
    expect((await login(newAgent(), 'rex@example.com')).status).toBe(401);

    const [event] = await events();
    expect(event).toMatchObject({
      type: 'LANDLORD_REJECTED',
      comment: 'Could not verify the property.',
    });
    expect((await admin.get(ADMIN_PAGE)).text).toContain('Could not verify the property.');
  });

  it('a blank reason is saved as no reason', async () => {
    const admin = await adminAgent();
    await registered('rex@example.com', 'LANDLORD');
    expect((await reject(admin, 'rex@example.com', '   ')).status).toBe(200);
    expect((await events())[0].comment).toBeNull();
  });

  it('a landlord can only be decided once (409), and the first decision stands', async () => {
    const admin = await adminAgent();
    await registered('lena@example.com', 'LANDLORD');
    expect((await approve(admin, 'lena@example.com')).status).toBe(200);

    for (const res of [
      await reject(admin, 'lena@example.com'),
      await approve(admin, 'lena@example.com'),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NOT_PENDING');
    }
    expect((await userByEmail('lena@example.com')).status).toBe('ACTIVE');
    expect(await prisma.accountEvent.count()).toBe(1);
  });

  it('race: two admins approve and reject at the same time, exactly one wins', async () => {
    const amy = await adminAgent('amy-admin@scu.edu');
    const bo = await adminAgent('bo-admin@scu.edu');
    const amyToken = await getCsrfToken(amy, ADMIN_PAGE);
    const boToken = await getCsrfToken(bo, ADMIN_PAGE);
    const send = (agent, token, path, body = {}) =>
      agent.post(path).set('x-csrf-token', token).set('Accept', 'application/json').send(body);

    for (let round = 1; round <= 5; round += 1) {
      const email = `race${round}@example.com`;
      const { id } = await createUser({ email, role: 'LANDLORD', status: 'PENDING' });
      const [ok, no] = await Promise.all([
        send(amy, amyToken, `/admin/landlords/${id}/approve`),
        send(bo, boToken, `/admin/landlords/${id}/reject`, { reason: 'race' }),
      ]);
      const label = `round ${round}: approve ${ok.status}, reject ${no.status}`;

      expect([ok.status, no.status].sort(), label).toEqual([200, 409]);
      const winner = ok.status === 200 ? 'ACTIVE' : 'REJECTED';
      expect((await userByEmail(email)).status, label).toBe(winner);
      expect(await prisma.accountEvent.count({ where: { targetUserId: id } }), label).toBe(1);
    }
  });

  it('only pending landlords can be decided: students and unknown ids are 404, bad ids 400', async () => {
    const admin = await adminAgent();
    await registered('sam@scu.edu', 'STUDENT');

    expect((await approve(admin, 'sam@scu.edu')).status).toBe(404);
    expect((await adminPost(admin, `/admin/landlords/${MISSING_ID}/reject`)).status).toBe(404);
    expect((await adminPost(admin, '/admin/landlords/not-a-uuid/approve')).status).toBe(400);
    expect((await userByEmail('sam@scu.edu')).status).toBe('ACTIVE');
    expect(await prisma.accountEvent.count()).toBe(0);
  });

  it('a reason that is too long is refused, and the form shows the error', async () => {
    const admin = await adminAgent();
    await registered('rex@example.com', 'LANDLORD');
    const id = await idOf('rex@example.com');

    const res = await postForm(
      admin,
      `/admin/landlords/${id}/reject`,
      { reason: 'x'.repeat(MAX_REASON_LENGTH + 1) },
      { tokenFrom: ADMIN_PAGE },
    );
    expect(res.status).toBe(400);
    expect(res.text).toContain(`${MAX_REASON_LENGTH} characters or fewer`);
    expect((await userByEmail('rex@example.com')).status).toBe('PENDING');
    expect(await prisma.accountEvent.count()).toBe(0);
  });
});

// --- promoting -----------------------------------------------------------------

describe('promote to admin', () => {
  it('promotes an active student; their current session gets admin access right away', async () => {
    const admin = await adminAgent();
    const sam = await registered('sam@scu.edu', 'STUDENT');
    expect((await sam.get('/dashboard/admin')).status).toBe(403);

    // Browser form, with messy input: email is trimmed and lowercased by zod.
    const res = await postForm(
      admin,
      '/admin/promote',
      { email: '  SAM@scu.edu ' },
      { tokenFrom: ADMIN_PAGE },
    );
    expect(res.status).toBe(302);

    expect((await userByEmail('sam@scu.edu')).role).toBe('ADMIN');
    expect((await sam.get('/dashboard/admin')).status).toBe(200);

    const [event] = await events();
    expect(event).toMatchObject({ type: 'PROMOTED_TO_ADMIN', detail: { fromRole: 'STUDENT' } });
    expect(event.target.email).toBe('sam@scu.edu');
  });

  it('promotes an approved landlord', async () => {
    const admin = await adminAgent();
    await createUser({ email: 'lena@example.com', role: 'LANDLORD', status: 'ACTIVE' });
    const res = await adminPost(admin, '/admin/promote', { email: 'lena@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ role: 'ADMIN', status: 'ACTIVE' });
    expect((await events())[0].detail).toEqual({ fromRole: 'LANDLORD' });
  });

  it('refuses a student who owns or belongs to an active roommate group, until they leave it', async () => {
    const admin = await adminAgent();
    const amy = await registered('amy@scu.edu', 'STUDENT');
    const ben = await registered('ben@scu.edu', 'STUDENT');
    const groupId = await createGroup(amy);
    const inviteId = await inviteAndGetId(amy, groupId, ben, 'ben@scu.edu');
    expect((await postJson(ben, `/invites/${inviteId}/accept`)).status).toBe(200);

    for (const email of ['amy@scu.edu', 'ben@scu.edu']) {
      const res = await adminPost(admin, '/admin/promote', { email });
      expect(res.status, email).toBe(409);
      expect(res.body.error.code, email).toBe('IN_ROOMMATE_GROUP');
      expect(res.body.error.message, email).toContain('"Hilltop House"');
      expect((await userByEmail(email)).role, email).toBe('STUDENT');
    }
    expect(await prisma.accountEvent.count()).toBe(0);

    // The HTML form shows the same message on the page.
    const page = await postForm(
      admin,
      '/admin/promote',
      { email: 'ben@scu.edu' },
      { tokenFrom: ADMIN_PAGE },
    );
    expect(page.status).toBe(409);
    expect(page.text).toContain('leave it or hand it off');

    // Ben leaves, then Amy (now alone) leaves and the group is disbanded: both can be promoted.
    expect((await postJson(ben, `/groups/${groupId}/leave`)).status).toBe(200);
    expect((await adminPost(admin, '/admin/promote', { email: 'ben@scu.edu' })).status).toBe(200);
    expect((await postJson(amy, `/groups/${groupId}/leave`)).body.disbanded).toBe(true);
    expect((await adminPost(admin, '/admin/promote', { email: 'amy@scu.edu' })).status).toBe(200);
  });

  it('race: promote vs. accepting a group invite, never an admin stuck in a group', async () => {
    const admin = await adminAgent();
    const amy = await registered('amy@scu.edu', 'STUDENT');
    const groupId = await createGroup(amy);
    const adminToken = await getCsrfToken(admin, ADMIN_PAGE);
    const tally = { acceptFirst: 0, promoteFirst: 0 };

    for (let round = 1; round <= 5; round += 1) {
      const email = `invitee${round}@scu.edu`;
      await createUser({ email, role: 'STUDENT' });
      const invitee = newAgent();
      await login(invitee, email);
      const inviteId = await inviteAndGetId(amy, groupId, invitee, email);
      const inviteeToken = await getCsrfToken(invitee, '/groups');

      const [acc, promo] = await Promise.all([
        invitee
          .post(`/invites/${inviteId}/accept`)
          .set('x-csrf-token', inviteeToken)
          .set('Accept', 'application/json'),
        admin
          .post('/admin/promote')
          .set('x-csrf-token', adminToken)
          .set('Accept', 'application/json')
          .send({ email }),
      ]);
      const label = `round ${round}: accept ${acc.status}, promote ${promo.status}`;
      const user = await userByEmail(email);
      const memberships = await prisma.groupMember.count({ where: { userId: user.id } });

      if (acc.status === 200) {
        tally.acceptFirst += 1;
        expect(promo.status, label).toBe(409);
        expect(promo.body.error.code, label).toBe('IN_ROOMMATE_GROUP');
        expect(user.role, label).toBe('STUDENT');
        expect(memberships, label).toBe(1);
      } else {
        tally.promoteFirst += 1;
        expect(promo.status, label).toBe(200);
        expect(acc.status, label).toBe(403); // admins can't use student group routes
        expect(user.role, label).toBe('ADMIN');
        expect(memberships, label).toBe(0);
      }
    }
    console.info('promote vs. accept, 5 rounds:', tally);
  });

  it('refuses unknown emails, admins, and accounts that are not active', async () => {
    const admin = await adminAgent();
    await registered('pending@example.com', 'LANDLORD');
    await createUser({ email: 'gone@scu.edu', role: 'STUDENT', status: 'SUSPENDED' });

    const cases = [
      ['nobody@scu.edu', 404, 'NOT_FOUND'],
      ['admin@scu.edu', 409, 'ALREADY_ADMIN'],
      ['pending@example.com', 409, 'ACCOUNT_NOT_ACTIVE'],
      ['gone@scu.edu', 409, 'ACCOUNT_NOT_ACTIVE'],
    ];
    for (const [email, status, code] of cases) {
      const res = await adminPost(admin, '/admin/promote', { email });
      expect(res.status, email).toBe(status);
      expect(res.body.error.code, email).toBe(code);
    }
    expect((await userByEmail('pending@example.com')).role).toBe('LANDLORD');
    expect(await prisma.accountEvent.count()).toBe(0);
  });

  it('shows form errors on the page: invalid email (400) and unknown email (404)', async () => {
    const admin = await adminAgent();
    const bad = await postForm(
      admin,
      '/admin/promote',
      { email: 'nope' },
      { tokenFrom: ADMIN_PAGE },
    );
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('Enter a valid email address.');

    const unknown = await postForm(
      admin,
      '/admin/promote',
      { email: 'nobody@scu.edu' },
      { tokenFrom: ADMIN_PAGE },
    );
    expect(unknown.status).toBe(404);
    expect(unknown.text).toContain('No account with that email.');
    expect(unknown.text).toContain('value="nobody@scu.edu"'); // the form keeps what was typed
  });
});

// --- authorization ---------------------------------------------------------------

describe('authorization', () => {
  it('students and landlords (pending or approved) get 403 everywhere, and nothing changes', async () => {
    await adminAgent();
    const target = await registered('target@example.com', 'LANDLORD');
    const targetId = await idOf('target@example.com');
    await createUser({ email: 'ok@example.com', role: 'LANDLORD', status: 'ACTIVE' });
    const okLandlord = newAgent();
    await login(okLandlord, 'ok@example.com');

    const people = [
      [await registered('sam@scu.edu', 'STUDENT'), '/dashboard/student'],
      [target, '/dashboard/landlord'], // can't approve themselves
      [okLandlord, '/dashboard/landlord'],
    ];
    for (const [agent, tokenFrom] of people) {
      expect((await agent.get(ADMIN_PAGE)).status).toBe(403);
      expect((await agent.get('/api/admin/landlords/pending')).status).toBe(403);
      for (const [path, body] of [
        [`/admin/landlords/${targetId}/approve`, {}],
        [`/admin/landlords/${targetId}/reject`, { reason: 'no' }],
        ['/admin/promote', { email: 'sam@scu.edu' }],
      ]) {
        const res = await postJson(agent, path, body, { tokenFrom });
        expect(res.status, path).toBe(403);
      }
    }

    expect((await userByEmail('target@example.com')).status).toBe('PENDING');
    expect((await userByEmail('sam@scu.edu')).role).toBe('STUDENT');
    expect(await prisma.accountEvent.count()).toBe(0);
  });

  it('anonymous users are sent to login (pages) or get 401 (API)', async () => {
    const anon = newAgent();
    const page = await anon.get(ADMIN_PAGE);
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/login');
    expect((await anon.get('/api/admin/landlords/pending')).status).toBe(401);
  });

  it('an admin POST without a CSRF token is refused (403)', async () => {
    const admin = await adminAgent();
    await registered('lena@example.com', 'LANDLORD');
    const res = await admin
      .post(`/admin/landlords/${await idOf('lena@example.com')}/approve`)
      .set('Accept', 'application/json');
    expect(res.status).toBe(403);
    expect((await userByEmail('lena@example.com')).status).toBe('PENDING');
  });
});
