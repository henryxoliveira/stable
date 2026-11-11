/**
 * Roommate groups (B1): multi-account workflows, authorization (403/404),
 * concurrency (one group per term), and invalid input.
 * Each newAgent() is a separate browser, i.e. a separate person.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, prisma, resetDb } from './helpers/db.js';
import { getCsrfToken, login, newAgent, postForm, postJson, register } from './helpers/http.js';
import { MAX_GROUP_SEATS, upcomingTerms } from '../src/services/group.service.js';

beforeEach(resetDb);

// Terms come from the live window (current quarter + next 5), so these tests
// keep passing in future quarters. Never hard-code a term here.
const TERMS = upcomingTerms();
const [TERM, NEXT_TERM] = TERMS;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

// --- helpers -----------------------------------------------------------------

/** Register a student and return their agent (logged in). */
async function student(email) {
  const agent = newAgent();
  const res = await register(agent, { email });
  expect(res.status).toBe(302);
  return agent;
}

async function createGroup(agent, { name = 'Hilltop House', term = TERM } = {}) {
  const res = await postJson(agent, '/groups', { name, term });
  expect(res.status).toBe(201);
  return res.body.group.id;
}

const invite = (agent, groupId, email) => postJson(agent, `/groups/${groupId}/invites`, { email });

const detail = async (agent, groupId) => (await agent.get(`/api/groups/${groupId}`)).body;

/** The invitation id this agent sees for a group (via their own /api/groups). */
async function myInviteId(agent, groupId) {
  const { invitations } = (await agent.get('/api/groups')).body;
  return invitations.find((i) => i.group.id === groupId)?.id;
}

async function accept(agent, groupId) {
  return postJson(agent, `/invites/${await myInviteId(agent, groupId)}/accept`);
}

async function userId(email) {
  return (await prisma.user.findUnique({ where: { email } })).id;
}

const eventTypes = async (groupId) =>
  (await prisma.groupEvent.findMany({ where: { groupId }, orderBy: { createdAt: 'asc' } })).map(
    (e) => e.type,
  );

// --- workflows -----------------------------------------------------------------

describe('group workflow', () => {
  it('create (HTML form) → invite two → both accept → ready, with an audit trail', async () => {
    const amy = await student('amy@scu.edu');
    const ben = await student('ben@scu.edu');
    const cal = await student('cal@scu.edu');

    // Browser form: term is normalized to upper case, then redirect to the group page.
    const created = await postForm(
      amy,
      '/groups',
      { name: 'Hilltop House', term: TERM.toLowerCase() },
      { tokenFrom: '/groups' },
    );
    expect(created.status).toBe(302);
    const groupId = created.headers.location.split('/').pop();
    const page = await amy.get(`/groups/${groupId}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Hilltop House');
    expect(page.text).toContain(TERM);

    expect((await invite(amy, groupId, 'ben@scu.edu')).status).toBe(201);
    expect((await invite(amy, groupId, 'CAL@scu.edu')).status).toBe(201); // lowercased
    let d = await detail(amy, groupId);
    expect(d.ready).toBe(false);
    expect(d.pendingInvites.map((p) => p.email)).toEqual(['ben@scu.edu', 'cal@scu.edu']);
    expect(d.seatsUsed).toBe(3);

    // Ben sees the invitation on /groups and in JSON, then accepts.
    expect((await ben.get('/groups')).text).toContain('Hilltop House');
    expect((await accept(ben, groupId)).status).toBe(200);
    expect((await detail(amy, groupId)).ready).toBe(false); // Cal still pending
    expect((await accept(cal, groupId)).status).toBe(200);

    d = await detail(amy, groupId);
    expect(d.ready).toBe(true);
    expect(d.members.map((m) => m.email)).toEqual(['amy@scu.edu', 'ben@scu.edu', 'cal@scu.edu']);
    expect(d.pendingInvites).toEqual([]);
    expect(JSON.stringify(d)).not.toMatch(/passwordHash|password_hash/);

    const bens = (await ben.get('/api/groups')).body;
    expect(bens.groups).toEqual([
      expect.objectContaining({ id: groupId, isOwner: false, memberCount: 3, ready: true }),
    ]);
    expect(bens.invitations).toEqual([]);

    expect(await eventTypes(groupId)).toEqual([
      'CREATED',
      'INVITED',
      'INVITED',
      'INVITE_ACCEPTED',
      'INVITE_ACCEPTED',
    ]);
  });

  it('an email invited BEFORE registering sees the invite after registering and can accept', async () => {
    const amy = await student('amy@scu.edu');
    const groupId = await createGroup(amy);
    expect((await invite(amy, groupId, 'dana@scu.edu')).status).toBe(201);

    const dana = await student('dana@scu.edu'); // registers afterwards
    const { invitations } = (await dana.get('/api/groups')).body;
    expect(invitations).toHaveLength(1);
    expect(invitations[0].group).toMatchObject({ id: groupId, ownerEmail: 'amy@scu.edu' });

    expect((await accept(dana, groupId)).status).toBe(200);
    expect((await detail(amy, groupId)).members.map((m) => m.email)).toContain('dana@scu.edu');
  });

  it('inviting does not reveal whether the email has an account', async () => {
    const amy = await student('amy@scu.edu');
    await student('registered@scu.edu');
    const groupId = await createGroup(amy);

    const known = await invite(amy, groupId, 'registered@scu.edu');
    const unknown = await invite(amy, groupId, 'nobody@scu.edu');
    expect(known.status).toBe(unknown.status);
    expect(Object.keys(known.body.invitation)).toEqual(Object.keys(unknown.body.invitation));
    expect(known.body.invitation.status).toBe(unknown.body.invitation.status);
  });

  it('decline, then the owner re-invites (same invitation row) and they accept', async () => {
    const amy = await student('amy@scu.edu');
    const ben = await student('ben@scu.edu');
    const groupId = await createGroup(amy);
    await invite(amy, groupId, 'ben@scu.edu');

    const inviteId = await myInviteId(ben, groupId);
    expect((await postJson(ben, `/invites/${inviteId}/decline`)).status).toBe(200);
    expect((await ben.get('/api/groups')).body.invitations).toEqual([]);
    expect((await detail(amy, groupId)).pendingInvites).toEqual([]);
    expect((await ben.get(`/api/groups/${groupId}`)).status).toBe(404); // no longer an invitee

    expect((await invite(amy, groupId, 'ben@scu.edu')).status).toBe(201);
    expect((await accept(ben, groupId)).status).toBe(200);
    expect(await prisma.groupInvitation.count({ where: { groupId } })).toBe(1);
    expect(await eventTypes(groupId)).toEqual([
      'CREATED',
      'INVITED',
      'INVITE_DECLINED',
      'INVITED',
      'INVITE_ACCEPTED',
    ]);
  });

  it('the owner cancels a pending invitation', async () => {
    const amy = await student('amy@scu.edu');
    const ben = await student('ben@scu.edu');
    const groupId = await createGroup(amy);
    await invite(amy, groupId, 'ben@scu.edu');
    const inviteId = (await detail(amy, groupId)).pendingInvites[0].id;

    const cancelPath = `/groups/${groupId}/invites/${inviteId}/cancel`;
    expect((await postJson(amy, cancelPath)).status).toBe(200);
    expect((await ben.get('/api/groups')).body.invitations).toEqual([]);
    expect((await postJson(ben, `/invites/${inviteId}/accept`)).status).toBe(404);
    expect((await postJson(amy, cancelPath)).status).toBe(409); // already cancelled
    expect(await eventTypes(groupId)).toEqual(['CREATED', 'INVITED', 'INVITE_CANCELLED']);
  });
});

describe('ownership and leaving', () => {
  /** Amy owns a group with Ben as an accepted member. */
  async function amyAndBen() {
    const amy = await student('amy@scu.edu');
    const ben = await student('ben@scu.edu');
    const groupId = await createGroup(amy);
    await invite(amy, groupId, 'ben@scu.edu');
    await accept(ben, groupId);
    return { amy, ben, groupId };
  }

  it('transfer ownership, then the old owner leaves', async () => {
    const { amy, ben, groupId } = await amyAndBen();
    const benId = await userId('ben@scu.edu');

    const t = await postJson(amy, `/groups/${groupId}/transfer`, { newOwnerId: benId });
    expect(t.status).toBe(200);
    const left = await postJson(amy, `/groups/${groupId}/leave`);
    expect(left.status).toBe(200);
    expect(left.body.disbanded).toBe(false);

    expect((await amy.get(`/groups/${groupId}`)).status).toBe(404);
    const d = await detail(ben, groupId);
    expect(d.group.owner.email).toBe('ben@scu.edu');
    expect(d.members.map((m) => m.email)).toEqual(['ben@scu.edu']);
    expect(await eventTypes(groupId)).toEqual([
      'CREATED',
      'INVITED',
      'INVITE_ACCEPTED',
      'OWNERSHIP_TRANSFERRED',
      'MEMBER_LEFT',
    ]);
  });

  it('the owner cannot leave while other members remain', async () => {
    const { amy, groupId } = await amyAndBen();
    const res = await postJson(amy, `/groups/${groupId}/leave`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TRANSFER_OWNERSHIP_FIRST');
    expect((await detail(amy, groupId)).members).toHaveLength(2);
  });

  it('transfer target must be another accepted member', async () => {
    const { amy, groupId } = await amyAndBen();
    await student('cal@scu.edu');
    const calId = await userId('cal@scu.edu');
    const amyId = await userId('amy@scu.edu');
    const path = `/groups/${groupId}/transfer`;
    expect((await postJson(amy, path, { newOwnerId: calId })).status).toBe(400);
    expect((await postJson(amy, path, { newOwnerId: amyId })).status).toBe(400);
  });

  it('the sole owner leaving disbands the group and cancels pending invites', async () => {
    const amy = await student('amy@scu.edu');
    const ben = await student('ben@scu.edu');
    const groupId = await createGroup(amy);
    await invite(amy, groupId, 'ben@scu.edu');

    const res = await postJson(amy, `/groups/${groupId}/leave`);
    expect(res.status).toBe(200);
    expect(res.body.disbanded).toBe(true);

    const group = await prisma.roommateGroup.findUnique({ where: { id: groupId } });
    expect(group.status).toBe('DISBANDED');
    expect(await prisma.groupInvitation.findMany({ where: { groupId } })).toEqual([
      expect.objectContaining({ email: 'ben@scu.edu', status: 'CANCELLED' }),
    ]);
    expect((await eventTypes(groupId)).at(-1)).toBe('DISBANDED');

    expect((await ben.get('/api/groups')).body.invitations).toEqual([]);
    expect((await amy.get('/api/groups')).body.groups).toEqual([]);
    expect((await amy.get(`/groups/${groupId}`)).status).toBe(404);

    // The term is free again for Amy.
    expect((await postJson(amy, '/groups', { name: 'Take two', term: TERM })).status).toBe(201);
  });
});

describe('one group per student per term', () => {
  it('sequential: a second group for the same term is refused (accept and create)', async () => {
    const amy = await student('amy@scu.edu');
    const ben = await student('ben@scu.edu');
    const cal = await student('cal@scu.edu');
    const g1 = await createGroup(amy, { name: 'G1' });
    const g2 = await createGroup(cal, { name: 'G2' });
    await invite(amy, g1, 'ben@scu.edu');
    await invite(cal, g2, 'ben@scu.edu');

    expect((await accept(ben, g1)).status).toBe(200);
    const second = await accept(ben, g2);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_IN_GROUP_FOR_TERM');

    const own = await postJson(ben, '/groups', { name: 'Mine', term: TERM });
    expect(own.status).toBe(409);
    // A different term is fine.
    expect((await postJson(ben, '/groups', { name: 'Mine', term: NEXT_TERM })).status).toBe(201);
  });

  it('parallel: two simultaneous accepts for the same term, exactly one wins', async () => {
    const amy = await student('amy@scu.edu');
    const ben = await student('ben@scu.edu');
    const cal = await student('cal@scu.edu');
    const g1 = await createGroup(amy, { name: 'G1' });
    const g2 = await createGroup(cal, { name: 'G2' });
    await invite(amy, g1, 'ben@scu.edu');
    await invite(cal, g2, 'ben@scu.edu');

    const token = await getCsrfToken(ben, '/groups');
    const ids = [await myInviteId(ben, g1), await myInviteId(ben, g2)];
    const results = await Promise.all(
      ids.map((id) =>
        ben
          .post(`/invites/${id}/accept`)
          .set('x-csrf-token', token)
          .set('Accept', 'application/json'),
      ),
    );

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const benId = await userId('ben@scu.edu');
    expect(await prisma.groupMember.count({ where: { userId: benId, term: TERM } })).toBe(1);
  });
});

describe('authorization', () => {
  it('a stranger gets 404 on the page and every action', async () => {
    const amy = await student('amy@scu.edu');
    await student('ben@scu.edu');
    const stranger = await student('sam@scu.edu');
    const groupId = await createGroup(amy);
    await invite(amy, groupId, 'ben@scu.edu');
    const inviteId = (await detail(amy, groupId)).pendingInvites[0].id;
    const amyId = await userId('amy@scu.edu');

    expect((await stranger.get(`/groups/${groupId}`)).status).toBe(404);
    expect((await stranger.get(`/api/groups/${groupId}`)).status).toBe(404);
    expect((await stranger.get(`/api/groups/${MISSING_ID}`)).status).toBe(404);
    const posts = [
      [`/groups/${groupId}/invites`, { email: 'x@scu.edu' }],
      [`/groups/${groupId}/invites/${inviteId}/cancel`, {}],
      [`/groups/${groupId}/transfer`, { newOwnerId: amyId }],
      [`/groups/${groupId}/leave`, {}],
      [`/invites/${inviteId}/accept`, {}], // Ben's invite, not Sam's
      [`/invites/${inviteId}/decline`, {}],
    ];
    for (const [path, body] of posts) {
      expect((await postJson(stranger, path, body)).status, path).toBe(404);
    }
    expect(await eventTypes(groupId)).toEqual(['CREATED', 'INVITED']); // nothing changed
  });

  it('a non-owner member or an invitee gets 403 for invite, cancel, and transfer', async () => {
    const amy = await student('amy@scu.edu');
    const ben = await student('ben@scu.edu');
    const cal = await student('cal@scu.edu');
    const groupId = await createGroup(amy);
    await invite(amy, groupId, 'ben@scu.edu');
    await accept(ben, groupId);
    await invite(amy, groupId, 'cal@scu.edu'); // Cal stays an invitee
    const inviteId = (await detail(amy, groupId)).pendingInvites[0].id;
    const benId = await userId('ben@scu.edu');

    for (const agent of [ben, cal]) {
      expect((await invite(agent, groupId, 'x@scu.edu')).status).toBe(403);
      const transfer = await postJson(agent, `/groups/${groupId}/transfer`, { newOwnerId: benId });
      expect(transfer.status).toBe(403);
      const cancel = await postJson(agent, `/groups/${groupId}/invites/${inviteId}/cancel`);
      expect(cancel.status).toBe(403);
    }
    // An invitee can view the group but not the other pending emails or history.
    const asInvitee = await detail(cal, groupId);
    expect(asInvitee.viewer.role).toBe('invitee');
    expect(asInvitee.pendingInvites).toEqual([]);
    expect(asInvitee.events).toEqual([]);
    expect((await postJson(cal, `/groups/${groupId}/leave`)).status).toBe(403);
  });

  it('landlords get 403; admins can view any group (200) but not act', async () => {
    const amy = await student('amy@scu.edu');
    const groupId = await createGroup(amy);

    const landlord = newAgent();
    await register(landlord, { email: 'lou@example.com', role: 'LANDLORD' });
    expect((await landlord.get('/groups')).status).toBe(403);
    expect((await landlord.get('/api/groups')).status).toBe(403);
    expect((await landlord.get(`/groups/${groupId}`)).status).toBe(403);
    const llPost = await postJson(
      landlord,
      '/groups',
      { name: 'x', term: TERM },
      { tokenFrom: '/dashboard/landlord' },
    );
    expect(llPost.status).toBe(403);

    await createUser({ email: 'admin@scu.edu', role: 'ADMIN' });
    const admin = newAgent();
    await login(admin, 'admin@scu.edu');
    const page = await admin.get(`/groups/${groupId}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Hilltop House');
    const json = await admin.get(`/api/groups/${groupId}`);
    expect(json.status).toBe(200);
    expect(json.body.viewer.role).toBe('admin');
    expect(json.body.events).toHaveLength(1);
    expect((await admin.get('/groups')).status).toBe(403);
    const adminInvite = await postJson(
      admin,
      `/groups/${groupId}/invites`,
      { email: 'x@scu.edu' },
      { tokenFrom: '/dashboard/admin' },
    );
    expect(adminInvite.status).toBe(403);
  });
});

describe('invalid input', () => {
  it('rejects bad terms and names (JSON 400, HTML form re-rendered with the message)', async () => {
    const amy = await student('amy@scu.edu');
    for (const term of ['FALL-27', 'AUTUMN-2027', 'FALL 2027', '']) {
      const res = await postJson(amy, '/groups', { name: 'Ok', term });
      expect(res.status, term).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.term).toBeDefined();
    }
    const noName = await postJson(amy, '/groups', { name: '   ', term: TERM });
    expect(noName.status).toBe(400);
    expect(noName.body.error.details.name).toBeDefined();

    const form = await postForm(
      amy,
      '/groups',
      { name: 'Ok', term: 'nope' },
      { tokenFrom: '/groups' },
    );
    expect(form.status).toBe(400);
    expect(form.text).toContain('Choose one of the upcoming terms');
    expect(await prisma.roommateGroup.count()).toBe(0);
  });

  it('rejects a past term or one outside the 6-quarter window (400)', async () => {
    const amy = await student('amy@scu.edu');
    // FALL of two years after the first term is always past the last allowed term.
    const firstYear = Number(TERM.split('-')[1]);
    const tooFar = `FALL-${firstYear + 2}`;
    expect(TERMS).not.toContain(tooFar);

    for (const term of ['FALL-2025', tooFar]) {
      const res = await postJson(amy, '/groups', { name: 'Ok', term });
      expect(res.status, term).toBe(400);
      expect(res.body.error.details.term).toMatch(/Choose one of the upcoming terms/);
    }
    expect(await prisma.roommateGroup.count()).toBe(0);
  });

  it('the create form offers exactly the upcoming terms as a dropdown', async () => {
    const amy = await student('amy@scu.edu');
    const page = (await amy.get('/groups')).text;
    expect(page).toContain('<select id="term" name="term"');
    const values = [...page.matchAll(/<option value="([A-Z]+-\d{4})"/g)].map((m) => m[1]);
    expect(values).toEqual(TERMS);
    const [season, year] = TERM.split('-');
    expect(page).toContain(`${season[0]}${season.slice(1).toLowerCase()} ${year}`); // e.g. "Fall 2026"
  });

  it('rejects malformed ids with 400', async () => {
    const amy = await student('amy@scu.edu');
    expect((await amy.get('/api/groups/not-a-uuid')).status).toBe(400);
    expect((await amy.get('/groups/123')).status).toBe(400);
    expect((await postJson(amy, '/invites/123/accept')).status).toBe(400);
    const groupId = await createGroup(amy);
    const t = await postJson(amy, `/groups/${groupId}/transfer`, { newOwnerId: 'abc' });
    expect(t.status).toBe(400);
  });

  it('rejects non-student emails, self-invites, and duplicate invites', async () => {
    const amy = await student('amy@scu.edu');
    const groupId = await createGroup(amy);

    for (const email of ['x@gmail.com', 'x@scu.edu.evil.com', 'x@notscu.edu', 'not-an-email']) {
      const res = await invite(amy, groupId, email);
      expect(res.status, email).toBe(400);
      expect(res.body.error.details.email).toBeDefined();
    }
    const self = await invite(amy, groupId, 'AMY@scu.edu');
    expect(self.status).toBe(400);

    expect((await invite(amy, groupId, 'ben@scu.edu')).status).toBe(201);
    const dup = await invite(amy, groupId, 'ben@scu.edu');
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('INVITE_EXISTS');
    expect(await prisma.groupInvitation.count({ where: { groupId } })).toBe(1);
  });

  it(`allows ${MAX_GROUP_SEATS} seats and refuses the next one`, async () => {
    const amy = await student('amy@scu.edu');
    const groupId = await createGroup(amy);
    const amyId = await userId('amy@scu.edu');

    // Owner (1 seat) + 14 pending invites inserted directly to keep the test fast.
    await prisma.groupInvitation.createMany({
      data: Array.from({ length: MAX_GROUP_SEATS - 2 }, (_, i) => ({
        groupId,
        email: `filler${i}@scu.edu`,
        invitedById: amyId,
      })),
    });
    expect((await invite(amy, groupId, 'sixteenth@scu.edu')).status).toBe(201);
    expect((await detail(amy, groupId)).seatsUsed).toBe(MAX_GROUP_SEATS);

    const extra = await invite(amy, groupId, 'seventeenth@scu.edu');
    expect(extra.status).toBe(409);
    expect(extra.body.error.code).toBe('GROUP_FULL');
  });
});
