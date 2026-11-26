/**
 * Cost calculator (B2) over HTTP: saving estimates, computed results,
 * ownership (404 / 403 / login redirect), group linking, database CHECK
 * constraints, and persistence across a fresh app instance.
 * Each newAgent() is a separate browser, i.e. a separate person.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma, resetDb } from './helpers/db.js';
import { login, newAgent, postForm, postJson, register } from './helpers/http.js';
import { upcomingTerms } from '../src/services/group.service.js';

beforeEach(resetDb);

const [TERM] = upcomingTerms();
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

/** A valid form, as a browser would send it (all text). */
const FORM = {
  name: 'Franklin St house',
  rent: '$4,000',
  utilities: '200',
  parking: '0',
  people: '3',
  leaseMonths: '12',
  onCampusQuarterly: '',
  quarters: '3',
  groupId: '',
};

async function student(email) {
  const agent = newAgent();
  expect((await register(agent, { email })).status).toBe(302);
  return agent;
}

async function createEstimate(agent, fields = {}) {
  const res = await postJson(agent, '/costs', { ...FORM, ...fields });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.estimate.id;
}

const getEstimate = async (agent, id) => (await agent.get(`/api/costs/${id}`)).body.estimate;

/** Amy owns a group for TERM with Ben as an accepted member (2 members). */
async function groupOfTwo() {
  const amy = await student('amy@scu.edu');
  const ben = await student('ben@scu.edu');
  const created = await postJson(amy, '/groups', { name: 'Hilltop House', term: TERM });
  const groupId = created.body.group.id;
  await postJson(amy, `/groups/${groupId}/invites`, { email: 'ben@scu.edu' });
  const { invitations } = (await ben.get('/api/groups')).body;
  expect((await postJson(ben, `/invites/${invitations[0].id}/accept`)).status).toBe(200);
  return { amy, ben, groupId };
}

describe('saving and viewing estimates', () => {
  it('form → saved → $4,000 + $200 split 3 ways shows $1,400.00 each', async () => {
    const amy = await student('amy@scu.edu');
    const res = await postForm(amy, '/costs', FORM, { tokenFrom: '/costs' });
    expect(res.status).toBe(302);
    const id = res.headers.location.split('/').pop();

    const page = await amy.get(`/costs/${id}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Franklin St house');
    expect(page.text).toContain('$4,200.00'); // monthly total
    expect(page.text).toContain('$1,400.00');

    const e = await getEstimate(amy, id);
    expect(e).toMatchObject({ rentCents: 400000, utilitiesCents: 20000, parkingCents: 0 });
    expect(e.result.shares).toEqual([140000, 140000, 140000]);
    expect(e.result.sharesDiffer).toBe(false);
    expect(e.result.comparison).toBeNull();
    expect(e.linkedGroup).toBeNull();

    expect((await amy.get('/costs')).text).toContain('Franklin St house'); // listed
  });

  it('uneven split and the on-campus comparison', async () => {
    const amy = await student('amy@scu.edu');
    const id = await createEstimate(amy, {
      rent: '4000.00',
      utilities: '0',
      onCampusQuarterly: '5,000',
    });
    const e = await getEstimate(amy, id);
    expect(e.result.shares).toEqual([133334, 133333, 133333]);
    expect(e.result.comparison).toEqual({
      offCampusPerPersonCents: 133334 * 12,
      onCampusPerPersonCents: 500000 * 3,
      differenceCents: 1600008 - 1500000,
      cheaper: 'on_campus',
    });
    const page = (await amy.get(`/costs/${id}`)).text;
    expect(page).toContain('$1,333.34');
    expect(page).toContain('the most anyone in the group pays');
    expect(page).toMatch(/On campus<\/strong> is cheaper by \$1,000\.08/);
  });

  it('defaults lease to 12 months and quarters to 3 when left blank', async () => {
    const amy = await student('amy@scu.edu');
    const id = await createEstimate(amy, { leaseMonths: '', quarters: '' });
    expect(await getEstimate(amy, id)).toMatchObject({ leaseMonths: 12, quarters: 3 });
  });

  it('the owner can delete an estimate; afterwards it is 404', async () => {
    const amy = await student('amy@scu.edu');
    const id = await createEstimate(amy);
    expect((await postJson(amy, `/costs/${id}/delete`, {}, { tokenFrom: '/costs' })).status).toBe(
      200,
    );
    expect((await amy.get(`/costs/${id}`)).status).toBe(404);
    expect(await prisma.costEstimate.count()).toBe(0);
  });
});

describe('invalid input', () => {
  it('JSON: 400 with a plain-English message per field, and nothing saved', async () => {
    const amy = await student('amy@scu.edu');
    const res = await postJson(amy, '/costs', {
      ...FORM,
      name: ' ',
      rent: '4,00',
      utilities: '-5',
      parking: '1.234',
      onCampusQuarterly: '100000.01',
      people: '17',
      leaseMonths: '25',
      quarters: '0',
      groupId: 'not-a-uuid',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toMatchObject({
      name: expect.any(String),
      rent: 'Enter an amount like 1250 or 1250.50.',
      utilities: "Amounts can't be negative.",
      parking: expect.stringMatching(/2 digits/),
      onCampusQuarterly: "Amounts can't be more than $100,000.",
      people: expect.stringMatching(/1 to 16/),
      leaseMonths: expect.stringMatching(/1 to 24/),
      quarters: expect.stringMatching(/1 to 4/),
      groupId: expect.any(String),
    });
    expect(await prisma.costEstimate.count()).toBe(0);
  });

  it('HTML form: re-renders with field errors and keeps what was typed', async () => {
    const amy = await student('amy@scu.edu');
    const res = await postForm(amy, '/costs', { ...FORM, rent: 'abc' }, { tokenFrom: '/costs' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Enter an amount like 1250 or 1250.50.');
    expect(res.text).toContain('value="Franklin St house"');
    expect(await prisma.costEstimate.count()).toBe(0);
  });

  it('no group and no number of people: 400 asking for people', async () => {
    const amy = await student('amy@scu.edu');
    const res = await postJson(amy, '/costs', { ...FORM, people: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.people).toMatch(/how many people/);
  });

  it('malformed estimate id: 400', async () => {
    const amy = await student('amy@scu.edu');
    expect((await amy.get('/api/costs/123')).status).toBe(400);
  });
});

describe('who can see what', () => {
  it("another student gets 404 for someone else's estimate (view and delete)", async () => {
    const amy = await student('amy@scu.edu');
    const sam = await student('sam@scu.edu');
    const id = await createEstimate(amy);

    expect((await sam.get(`/costs/${id}`)).status).toBe(404);
    expect((await sam.get(`/api/costs/${id}`)).status).toBe(404);
    expect((await sam.get(`/api/costs/${MISSING_ID}`)).status).toBe(404); // same as missing
    expect((await postJson(sam, `/costs/${id}/delete`, {}, { tokenFrom: '/costs' })).status).toBe(
      404,
    );
    expect((await sam.get('/api/costs')).body.estimates).toEqual([]);
    expect(await prisma.costEstimate.count()).toBe(1); // still there
  });

  it('a landlord gets 403 on every cost route', async () => {
    const amy = await student('amy@scu.edu');
    const id = await createEstimate(amy);
    const landlord = newAgent();
    await register(landlord, { email: 'lou@example.com', role: 'LANDLORD' });

    expect((await landlord.get('/costs')).status).toBe(403);
    expect((await landlord.get('/api/costs')).status).toBe(403);
    expect((await landlord.get(`/costs/${id}`)).status).toBe(403);
    const opts = { tokenFrom: '/dashboard/landlord' };
    expect((await postJson(landlord, '/costs', FORM, opts)).status).toBe(403);
    expect((await postJson(landlord, `/costs/${id}/delete`, {}, opts)).status).toBe(403);
  });

  it('logged-out users are sent to /login (pages) or get 401 (API)', async () => {
    const anon = newAgent();
    for (const path of ['/costs', `/costs/${MISSING_ID}`]) {
      const res = await anon.get(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.location).toBe('/login');
    }
    expect((await anon.get('/api/costs')).status).toBe(401);
  });
});

describe('linking a roommate group', () => {
  it("a member who leaves people blank gets the group's member count", async () => {
    const { amy, groupId } = await groupOfTwo();
    const id = await createEstimate(amy, { groupId, people: '' });
    const e = await getEstimate(amy, id);
    expect(e.people).toBe(2);
    expect(e.result.shares).toEqual([210000, 210000]);
    expect(e.linkedGroup).toMatchObject({ available: true, name: 'Hilltop House', memberCount: 2 });
    const page = (await amy.get(`/costs/${id}`)).text;
    expect(page).toContain('Hilltop House');
    expect(page).toContain('2 members now');
  });

  it('a group with one member says "1 member now", not "1 members"', async () => {
    const amy = await student('amy@scu.edu');
    const created = await postJson(amy, '/groups', { name: 'Solo Studio', term: TERM });
    const groupId = created.body.group.id;
    const id = await createEstimate(amy, { groupId, people: '' });
    expect((await getEstimate(amy, id)).people).toBe(1);

    const page = (await amy.get(`/costs/${id}`)).text;
    expect(page).toContain('Solo Studio');
    expect(page).toContain('1 member now');
    expect(page).not.toContain('1 members');
  });

  it('a number of people typed in overrides the group size', async () => {
    const { amy, groupId } = await groupOfTwo();
    const id = await createEstimate(amy, { groupId, people: '4' });
    expect((await getEstimate(amy, id)).people).toBe(4);
  });

  it('a non-member, or someone only invited, gets 404 when linking the group', async () => {
    const { amy, groupId } = await groupOfTwo();
    const sam = await student('sam@scu.edu');
    expect((await postJson(sam, '/costs', { ...FORM, groupId })).status).toBe(404);

    await student('cal@scu.edu');
    await postJson(amy, `/groups/${groupId}/invites`, { email: 'cal@scu.edu' });
    const cal = newAgent();
    await login(cal, 'cal@scu.edu');
    expect((await postJson(cal, '/costs', { ...FORM, groupId })).status).toBe(404);
    expect(await prisma.costEstimate.count()).toBe(0);
  });

  it('after leaving the group, the estimate shows "Linked group no longer available" and no group details', async () => {
    const { ben, groupId } = await groupOfTwo();
    const id = await createEstimate(ben, { groupId, people: '' });
    expect((await postJson(ben, `/groups/${groupId}/leave`)).status).toBe(200);

    const page = await ben.get(`/costs/${id}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Linked group no longer available');
    expect(page.text).not.toContain('Hilltop House');
    expect(page.text).not.toContain(`/groups/${groupId}`);
    const e = await getEstimate(ben, id);
    expect(e.linkedGroup).toEqual({ available: false });
    expect(e.people).toBe(2); // the saved inputs are unchanged
  });
});

describe('database guards and persistence', () => {
  it('the database itself rejects bad rows inserted directly (CHECK constraints)', async () => {
    await student('amy@scu.edu');
    const { id: userId } = await prisma.user.findUnique({ where: { email: 'amy@scu.edu' } });
    const good = {
      userId,
      name: 'Direct insert',
      people: 2,
      rentCents: 100,
      utilitiesCents: 0,
      parkingCents: 0,
    };
    const bad = [
      [{ people: 0 }, 'cost_estimates_people_check'],
      [{ people: 17 }, 'cost_estimates_people_check'],
      [{ rentCents: -1 }, 'cost_estimates_rent_cents_check'],
      [{ utilitiesCents: -1 }, 'cost_estimates_utilities_cents_check'],
      [{ parkingCents: -1 }, 'cost_estimates_parking_cents_check'],
      [{ onCampusQuarterlyCents: -1 }, 'cost_estimates_on_campus_quarterly_cents_check'],
      [{ leaseMonths: 25 }, 'cost_estimates_lease_months_check'],
      [{ quarters: 5 }, 'cost_estimates_quarters_check'],
    ];
    for (const [override, constraint] of bad) {
      await expect(
        prisma.costEstimate.create({ data: { ...good, ...override } }),
        constraint,
      ).rejects.toThrow(constraint);
    }
    expect(await prisma.costEstimate.count()).toBe(0);
    await prisma.costEstimate.create({ data: good }); // the valid row is accepted
    expect(await prisma.costEstimate.count()).toBe(1);
  });

  it('an estimate is still readable from a fresh app instance (data lives in Postgres)', async () => {
    const amy = await student('amy@scu.edu');
    const id = await createEstimate(amy, { rent: '4000', utilities: '0' });

    // A brand-new Express app, like a redeploy: nothing carried over in memory.
    const freshAgent = request.agent(createApp());
    await login(freshAgent, 'amy@scu.edu');
    const res = await freshAgent.get(`/api/costs/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.estimate).toMatchObject({ name: 'Franklin St house', rentCents: 400000 });
    expect(res.body.estimate.result.shares).toEqual([133334, 133333, 133333]);
  });
});
