/**
 * Group applications (B3 part 2): multi-account workflows, every 403/404,
 * invalid input, the double-apply race, offer expiry at the exact deadline, and
 * the audit events. Each agent is a separate person (browser).
 *
 * Setup inserts users, groups, and units directly (B1 and A2 test those flows
 * through the UI); everything about applications goes through HTTP.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, prisma, resetDb } from './helpers/db.js';
import { newAgent, postForm } from './helpers/http.js';
import { expireDueOffers, move } from '../src/services/application.service.js';
import { termLabel } from '../src/services/group.service.js';
import { formatPacific } from '../src/controllers/applications.controller.js';
import {
  MISSING_ID,
  NEXT_TERM,
  TERM,
  act,
  appliedWorld,
  applyAs,
  events,
  makeGroup,
  makeUnit,
  offeredWorld,
  person,
  world,
} from './helpers/applications.js';

beforeEach(resetDb);

describe('full workflow', () => {
  it('apply → documents requested → documents sent → review → offer → decline, with an event for every move', async () => {
    const { amy, ben, lou, unit, group } = await world();

    const applied = await applyAs(amy, unit.id, group.id);
    expect(applied.status).toBe(201);
    const id = applied.body.application.id;
    expect(applied.body.application).toMatchObject({ status: 'SUBMITTED', unitId: unit.id });

    const steps = [
      [lou, 'request-documents', { comment: 'Please send proof of income.' }, 'DOCS_REQUESTED'],
      [ben, 'send-documents', { comment: 'Sent pay stubs by email' }, 'SUBMITTED'],
      [lou, 'start-review', {}, 'UNDER_REVIEW'],
      [lou, 'offer', { offerDays: 3 }, 'OFFERED'],
      [amy, 'decline', { comment: 'We found another place.' }, 'DECLINED'],
    ];
    for (const [who, slug, body, status] of steps) {
      const res = await act(who, id, slug, body);
      expect(res.status, slug).toBe(200);
      expect(res.body.application.status).toBe(status);
    }

    const rows = await events(id);
    expect(rows.map((e) => [e.actorType, e.fromStatus, e.toStatus, e.comment])).toEqual([
      ['GROUP_MEMBER', null, 'SUBMITTED', null],
      ['LISTING_OWNER', 'SUBMITTED', 'DOCS_REQUESTED', 'Please send proof of income.'],
      ['GROUP_MEMBER', 'DOCS_REQUESTED', 'SUBMITTED', 'Sent pay stubs by email'],
      ['LISTING_OWNER', 'SUBMITTED', 'UNDER_REVIEW', null],
      ['LISTING_OWNER', 'UNDER_REVIEW', 'OFFERED', null],
      ['GROUP_MEMBER', 'OFFERED', 'DECLINED', 'We found another place.'],
    ]);
    expect(rows.map((e) => e.actorId)).toEqual([
      amy.user.id,
      lou.user.id,
      ben.user.id,
      lou.user.id,
      lou.user.id,
      amy.user.id,
    ]);
    const app = await prisma.application.findUnique({ where: { id } });
    expect(app.groupSize).toBe(2);
    expect(app.offerExpiresAt.getTime()).toBeGreaterThan(Date.now() + 2.9 * 24 * 3600 * 1000);
  });

  it('pages: the group sees status and history; the landlord sees buttons from allowedMoves()', async () => {
    const { amy, lou, unit, appId } = await appliedWorld();

    const mine = await amy.get('/applications');
    expect(mine.status).toBe(200);
    expect(mine.text).toContain('Franklin House, 2B');
    expect(mine.text).toContain('Submitted');
    expect(mine.text).toContain(`/applications/${appId}/withdraw`);
    expect(mine.text).not.toContain('/start-review');

    const incoming = await lou.get(`/units/${unit.id}/applications`);
    expect(incoming.status).toBe(200);
    expect(incoming.text).toContain('Hilltop');
    for (const slug of ['request-documents', 'start-review', 'reject']) {
      expect(incoming.text).toContain(`/applications/${appId}/${slug}`);
    }
    expect(incoming.text).not.toContain(`/applications/${appId}/offer`); // not until under review
    expect(incoming.text).not.toContain('/withdraw');

    const json = await amy.get(`/api/applications/${appId}`);
    expect(json.body.application.viewer).toEqual({
      role: 'GROUP_MEMBER',
      moves: [
        { slug: 'withdraw', label: 'Withdraw', commentRequired: false, needsDeadline: false },
      ],
    });
    expect(json.body.application.events).toHaveLength(1);
  });

  it('HTML forms: apply redirects to the application; reject (with a reason) returns to the unit page', async () => {
    const { amy, lou, unit, group } = await world();
    const applied = await postForm(
      amy.agent,
      `/units/${unit.id}/apply`,
      { groupId: group.id },
      {
        tokenFrom: `/units/${unit.id}/apply`,
      },
    );
    expect(applied.status).toBe(302);
    const id = applied.headers.location.split('/').pop();
    expect(applied.headers.location).toBe(`/applications/${id}`);

    const rejected = await postForm(
      lou.agent,
      `/applications/${id}/reject`,
      { comment: 'Unit promised to someone else.' },
      {
        tokenFrom: `/units/${unit.id}/applications`,
      },
    );
    expect(rejected.status).toBe(302);
    expect(rejected.headers.location).toBe(`/units/${unit.id}/applications`);
    expect((await events(id)).at(-1)).toMatchObject({
      toStatus: 'REJECTED',
      comment: 'Unit promised to someone else.',
    });

    // A finished application doesn't block applying again.
    expect((await applyAs(amy, unit.id, group.id)).status).toBe(201);
  });
});

describe('applying: who and when', () => {
  it('a student who is not an accepted member of the group gets 404', async () => {
    const { sam, unit, group } = await world();
    expect((await applyAs(sam, unit.id, group.id)).status).toBe(404);
    expect(await prisma.application.count()).toBe(0);
  });

  it('a group that is not ready (someone still invited) gets 409', async () => {
    const { amy, unit } = await world();
    // Amy is already in Hilltop for TERM (one group per term), so use the next term.
    const solo = await makeGroup('Pending', [amy.user], ['cal@scu.edu'], NEXT_TERM);
    const res = await applyAs(amy, unit.id, solo.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GROUP_NOT_READY');
  });

  it('a group too big for the unit gets 409 with the reason from groupFitsUnit()', async () => {
    const { amy, lou, group } = await world();
    const studio = await makeUnit(lou.user.id, { beds: 1, bedrooms: 0, label: 'Studio' });
    const res = await applyAs(amy, studio.id, group.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'GROUP_TOO_BIG',
      message: 'This unit fits 1 person, but the group has 2.',
    });
  });

  it('a leased unit gets 409; a pending landlord’s unit and a missing unit get 404', async () => {
    const { amy, lou, group } = await world();
    const leased = await makeUnit(lou.user.id, { label: 'Leased', status: 'LEASED' });
    expect((await applyAs(amy, leased.id, group.id)).body.error.code).toBe('UNIT_NOT_AVAILABLE');

    const pending = await createUser({
      email: 'pat@example.com',
      role: 'LANDLORD',
      status: 'PENDING',
    });
    const hidden = await makeUnit(pending.id, { label: 'Hidden' });
    expect((await applyAs(amy, hidden.id, group.id)).status).toBe(404);
    expect((await amy.get(`/units/${hidden.id}/apply`)).status).toBe(404);
    expect((await applyAs(amy, MISSING_ID, group.id)).status).toBe(404);
    expect(await prisma.application.count()).toBe(0);
  });

  it('one open application per group per unit: 409, then allowed again after withdrawing', async () => {
    const { amy, ben, unit, group, appId } = await appliedWorld();
    const again = await applyAs(ben, unit.id, group.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_APPLIED');

    expect((await act(ben, appId, 'withdraw', { comment: 'Changed plans' })).status).toBe(200);
    expect((await applyAs(amy, unit.id, group.id)).status).toBe(201);
  });

  it('race: two members apply at the same moment (×10), exactly one application each time', async () => {
    const { amy, ben, unit, group } = await world();
    for (let round = 1; round <= 10; round += 1) {
      await prisma.applicationEvent.deleteMany();
      await prisma.application.deleteMany();
      const results = await Promise.all([
        applyAs(amy, unit.id, group.id),
        applyAs(ben, unit.id, group.id),
      ]);
      expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([201, 409]);
      expect(await prisma.application.count()).toBe(1);
    }
  }, 60_000);
});

describe('offers', () => {
  it('only one open offer per unit; rescinding frees it for another group', async () => {
    const { lou, unit, appId } = await offeredWorld();
    const cal = await person('cal@scu.edu', 'STUDENT');
    const other = await makeGroup('Second', [cal.user]);
    const second = (await applyAs(cal, unit.id, other.id)).body.application.id;
    expect((await act(lou, second, 'start-review')).status).toBe(200);

    const blocked = await act(lou, second, 'offer', { offerDays: 2 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('UNIT_HAS_OPEN_OFFER');

    expect((await act(lou, appId, 'rescind', { comment: 'Changed my mind' })).status).toBe(200);
    expect((await act(lou, second, 'offer', { offerDays: 2 })).status).toBe(200);
  });

  it("another group's expired-but-unread offer doesn't block offering the unit to someone else", async () => {
    // Group X (Hilltop) gets an offer; group Y (Second) applies and is under review.
    const { lou, unit, appId: xId } = await offeredWorld();
    const cal = await person('cal@scu.edu', 'STUDENT');
    const y = await makeGroup('Second', [cal.user]);
    const yId = (await applyAs(cal, unit.id, y.id)).body.application.id;
    expect((await act(lou, yId, 'start-review')).status).toBe(200);

    // X's deadline passes, and nobody reads X's application afterwards.
    await prisma.application.update({
      where: { id: xId },
      data: { offerExpiresAt: new Date(Date.now() - 1000) },
    });
    expect((await prisma.application.findUnique({ where: { id: xId } })).status).toBe('OFFERED');

    // The landlord offers the unit to Y: X's stale offer must not block it.
    const offered = await act(lou, yId, 'offer', { offerDays: 2 });
    expect(offered.status).toBe(200);
    expect(offered.body.application.status).toBe('OFFERED');

    expect((await prisma.application.findUnique({ where: { id: xId } })).status).toBe('EXPIRED');
    const xSystem = (await events(xId)).filter((e) => e.actorType === 'SYSTEM');
    expect(xSystem).toHaveLength(1);
    expect(xSystem[0]).toMatchObject({ fromStatus: 'OFFERED', toStatus: 'EXPIRED', actorId: null });
  });

  it('the deadline must be in the future and at most 14 days away', async () => {
    const { lou, appId } = await appliedWorld();
    await act(lou, appId, 'start-review');
    const iso = (ms) => new Date(Date.now() + ms).toISOString();
    for (const body of [
      { offerExpiresAt: iso(-60_000) },
      { offerExpiresAt: iso(15 * 24 * 3600 * 1000) },
      { offerDays: 15 },
      { offerDays: 0 },
      {},
      { offerDays: 3, offerExpiresAt: iso(3600 * 1000) },
      { offerExpiresAt: 'next Friday' },
    ]) {
      expect((await act(lou, appId, 'offer', body)).status, JSON.stringify(body)).toBe(400);
    }
    const ok = await act(lou, appId, 'offer', { offerExpiresAt: iso(2 * 24 * 3600 * 1000) });
    expect(ok.status).toBe(200);
  });

  it('illegal moves get 409 with the workflow’s reason, and nothing changes', async () => {
    const { lou, appId } = await appliedWorld();
    const early = await act(lou, appId, 'offer', { offerDays: 3 });
    expect(early.status).toBe(409);
    expect(early.body.error.message).toBe(
      'An application can\'t go from "Submitted" to "Offer made".',
    );

    await act(lou, appId, 'start-review');
    await act(lou, appId, 'offer', { offerDays: 3 });
    // "Start review" also ends in UNDER_REVIEW, but must not act as "rescind".
    const wrong = await act(lou, appId, 'start-review');
    expect(wrong.status).toBe(409);
    expect((await prisma.application.findUnique({ where: { id: appId } })).status).toBe('OFFERED');
  });
});

describe('offer expiry (check-on-read)', () => {
  it('exactly at the deadline the offer expires, with one SYSTEM event (not 1 ms before)', async () => {
    const { appId } = await offeredWorld();
    const { offerExpiresAt: deadline } = await prisma.application.findUnique({
      where: { id: appId },
    });

    expect(await expireDueOffers({ id: appId }, new Date(deadline.getTime() - 1))).toBe(0);
    expect((await prisma.application.findUnique({ where: { id: appId } })).status).toBe('OFFERED');

    expect(await expireDueOffers({ id: appId }, deadline)).toBe(1);
    expect((await prisma.application.findUnique({ where: { id: appId } })).status).toBe('EXPIRED');
    expect((await events(appId)).at(-1)).toMatchObject({
      actorType: 'SYSTEM',
      actorId: null,
      fromStatus: 'OFFERED',
      toStatus: 'EXPIRED',
      comment: 'The offer deadline passed.',
    });
    expect(await expireDueOffers({ id: appId }, deadline)).toBe(0); // only once
  });

  it('a past deadline expires on the next read: parallel reads write exactly one event', async () => {
    const { amy, ben, lou, unit, appId } = await offeredWorld();
    await prisma.application.update({
      where: { id: appId },
      data: { offerExpiresAt: new Date(Date.now() - 1000) },
    });
    const reads = await Promise.all([
      amy.get(`/api/applications/${appId}`),
      ben.get('/api/applications'),
      lou.get(`/api/units/${unit.id}/applications`),
      amy.get('/applications'),
    ]);
    expect(reads.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(reads[0].body.application.status).toBe('EXPIRED');
    const systemEvents = (await events(appId)).filter((e) => e.actorType === 'SYSTEM');
    expect(systemEvents).toHaveLength(1);
  });

  it('declining after the deadline is refused (already expired), and the expiry sticks', async () => {
    const { amy, appId } = await offeredWorld();
    await prisma.application.update({
      where: { id: appId },
      data: { offerExpiresAt: new Date(Date.now() - 1000) },
    });
    const res = await act(amy, appId, 'decline');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FINAL_STATE');
    expect((await prisma.application.findUnique({ where: { id: appId } })).status).toBe('EXPIRED');
  });
});

describe('who can see and do what', () => {
  it('an outsider student gets 404 on the application and every group move', async () => {
    const { sam, appId } = await appliedWorld();
    expect((await sam.get(`/applications/${appId}`)).status).toBe(404);
    expect((await sam.get(`/api/applications/${appId}`)).status).toBe(404);
    for (const slug of ['withdraw', 'decline']) {
      expect((await act(sam, appId, slug)).status, slug).toBe(404);
    }
    expect((await act(sam, appId, 'send-documents', { comment: 'x' })).status).toBe(404);
    expect((await sam.get('/api/applications')).body.applications).toEqual([]);
  });

  it('another landlord gets 404 on the unit’s list, the application, and every landlord move', async () => {
    const { lia, unit, appId } = await appliedWorld();
    expect((await lia.get(`/units/${unit.id}/applications`)).status).toBe(404);
    expect((await lia.get(`/api/applications/${appId}`)).status).toBe(404);
    for (const [slug, body] of [
      ['request-documents', { comment: 'x' }],
      ['start-review', {}],
      ['offer', { offerDays: 2 }],
      ['rescind', {}],
      ['reject', {}],
    ]) {
      expect((await act(lia, appId, slug, body)).status, slug).toBe(404);
    }
    expect(await events(appId)).toHaveLength(1); // nothing changed
  });

  it('a student on landlord moves, and a landlord on group moves, get 403', async () => {
    const { amy, lou, appId } = await appliedWorld();
    expect((await act(amy, appId, 'start-review')).status).toBe(403);
    expect((await act(amy, appId, 'request-documents', { comment: 'x' })).status).toBe(403);
    expect((await act(lou, appId, 'withdraw')).status).toBe(403);
    expect((await lou.post('/api/units/x/applications', {})).status).toBe(403);
    expect((await lou.get('/applications')).status).toBe(403);
  });

  it('even past the route checks, the wrong actor gets 403 from canTransition()', async () => {
    const { lou, appId } = await appliedWorld();
    await expect(move(lou.user, appId, 'withdraw')).rejects.toMatchObject({
      status: 403,
      code: 'WRONG_ACTOR',
    });
  });

  it('an admin can view but every action is 403', async () => {
    const { unit, appId } = await appliedWorld();
    const admin = await person('admin@scu.edu', 'ADMIN');
    expect((await admin.get(`/applications/${appId}`)).status).toBe(200);
    expect((await admin.get(`/api/units/${unit.id}/applications`)).status).toBe(200);
    const viewed = await admin.get(`/api/applications/${appId}`);
    expect(viewed.body.application.viewer).toEqual({ role: 'ADMIN', moves: [] });
    expect((await act(admin, appId, 'start-review')).status).toBe(403);
    expect((await act(admin, appId, 'withdraw')).status).toBe(403);
    await expect(move(admin.user, appId, 'reject')).rejects.toMatchObject({ status: 403 });
  });

  it('a pending landlord gets 403 ACCOUNT_PENDING on landlord moves', async () => {
    const { appId } = await appliedWorld();
    const pat = await person('pat@example.com', 'LANDLORD', 'PENDING');
    const res = await act(pat, appId, 'start-review');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_PENDING');
  });

  it('logged-out visitors go to /login (API: 401)', async () => {
    for (const path of [
      '/applications',
      `/applications/${MISSING_ID}`,
      `/units/${MISSING_ID}/applications`,
    ]) {
      const res = await newAgent().get(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.location).toBe('/login');
    }
    expect((await newAgent().get(`/api/applications/${MISSING_ID}`)).status).toBe(401);
  });
});

describe('invalid input', () => {
  it('bad ids, missing or too-long comments, and a bad group id get 400', async () => {
    const { amy, lou, unit, appId } = await appliedWorld();
    expect((await amy.get('/api/applications/not-a-uuid')).status).toBe(400);
    expect((await applyAs(amy, unit.id, 'not-a-uuid')).status).toBe(400);
    expect((await amy.post('/api/units/nope/applications', { groupId: MISSING_ID })).status).toBe(
      400,
    );

    const noComment = await act(lou, appId, 'request-documents', { comment: '   ' });
    expect(noComment.status).toBe(400);
    expect(noComment.body.error.details.comment).toBe('Add a short comment.');
    const tooLong = await act(lou, appId, 'reject', { comment: 'x'.repeat(501) });
    expect(tooLong.status).toBe(400);

    await act(lou, appId, 'request-documents', { comment: 'Proof of income, please.' });
    expect((await act(amy, appId, 'send-documents', {})).status).toBe(400);
    expect(await events(appId)).toHaveLength(2); // only apply + request documents happened
  });

  it('the database refuses an OFFERED application without a deadline (CHECK constraint)', async () => {
    const { appId } = await appliedWorld();
    await expect(
      prisma.application.update({ where: { id: appId }, data: { status: 'OFFERED' } }),
    ).rejects.toThrow('applications_offer_needs_deadline_check');
  });
});

describe('apply page, term labels, and history (UI)', () => {
  it('a refused apply re-shows the apply page with the message; ALREADY_APPLIED links to the application', async () => {
    const { amy, ben, unit, group, appId } = await appliedWorld();
    const opts = { tokenFrom: `/units/${unit.id}/apply` };
    const res = await postForm(ben.agent, `/units/${unit.id}/apply`, { groupId: group.id }, opts);
    expect(res.status).toBe(409);
    expect(res.text).toContain('Apply as a group'); // the apply page, not the error page
    expect(res.text).toContain('Your group already has an open application for this unit.');
    expect(res.text).toContain(`<a href="/applications/${appId}">See your group's application</a>`);
    expect(res.text).toMatch(new RegExp(`<option value="${group.id}" selected`));

    // Not ready: the message is shown, with no link.
    const solo = await makeGroup('Pending', [amy.user], ['cal@scu.edu'], NEXT_TERM);
    const notReady = await postForm(
      amy.agent,
      `/units/${unit.id}/apply`,
      { groupId: solo.id },
      opts,
    );
    expect(notReady.status).toBe(409);
    expect(notReady.text).toContain('Apply as a group');
    expect(notReady.text).toContain('isn’t ready yet');
    expect(notReady.text).not.toContain('See your group');

    // The JSON API still answers 409 with the code (and now the existing id).
    const api = await applyAs(ben, unit.id, group.id);
    expect(api.status).toBe(409);
    expect(api.body.error).toMatchObject({
      code: 'ALREADY_APPLIED',
      details: { applicationId: appId },
    });
  });

  it('the apply page hides the Submit button when the unit is not available', async () => {
    const { amy, lou } = await world();
    const leased = await makeUnit(lou.user.id, { label: 'Leased', status: 'LEASED' });
    const page = await amy.get(`/units/${leased.id}/apply`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("This unit isn't available right now.");
    expect(page.text).not.toContain('Submit application');
    expect(page.text).not.toContain(`action="/units/${leased.id}/apply"`);
  });

  it('applications pages show friendly term labels ("Fall 2026", not "FALL-2026")', async () => {
    const { amy, unit, appId } = await appliedWorld();
    for (const path of ['/applications', `/applications/${appId}`, `/units/${unit.id}/apply`]) {
      const text = (await amy.get(path)).text;
      expect(text, path).toContain(termLabel(TERM));
      expect(text, path).not.toContain(TERM);
    }
  });

  it('the latest "Offer made" history line shows its deadline', async () => {
    const { amy, lou, appId } = await offeredWorld();
    const first = (await prisma.application.findUnique({ where: { id: appId } })).offerExpiresAt;
    const page = (await amy.get(`/applications/${appId}`)).text;
    expect(page).toContain(`Under review → Offer made (open until ${formatPacific(first)})`);

    // Rescind and offer again: only the latest offer line carries a deadline (the new one).
    await act(lou, appId, 'rescind');
    await act(lou, appId, 'offer', { offerDays: 5 });
    const second = (await prisma.application.findUnique({ where: { id: appId } })).offerExpiresAt;
    const evts = (await amy.get(`/api/applications/${appId}`)).body.application.events;
    const offerLines = evts.filter((e) => e.toStatus === 'OFFERED');
    expect(offerLines).toHaveLength(2);
    expect(offerLines[0].offerExpiresAt).toBeNull();
    expect(new Date(offerLines[1].offerExpiresAt).getTime()).toBe(second.getTime());
    const page2 = (await amy.get(`/applications/${appId}`)).text;
    expect(page2).toContain(`(open until ${formatPacific(second)})`);
    expect(page2).not.toContain(`(open until ${formatPacific(first)})`);
  });
});
