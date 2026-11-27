/**
 * Accepting an offer (B5): one locked transaction leases the unit, accepts the
 * application, and closes every other open application for the unit and from the
 * group. Covers races, the exact deadline, re-checks, and access.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, prisma, resetDb } from './helpers/db.js';
import { postForm } from './helpers/http.js';
import {
  CLOSE_REASON_GROUP_PLACED,
  CLOSE_REASON_UNIT_LEASED,
  accept,
} from '../src/services/application.service.js';
import {
  MISSING_ID,
  TERM,
  act,
  applyAs,
  events,
  makeGroup,
  makeUnit,
  offeredWorld,
  person,
} from './helpers/applications.js';

beforeEach(resetDb);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RESCIND_DELAYS_MS = [0, 100, 200, 300, 400, 500];
const acceptAs = (p, id) => p.post(`/api/applications/${id}/accept`);
const statusOf = async (id) => (await prisma.application.findUnique({ where: { id } })).status;
const unitStatus = async (id) => (await prisma.unit.findUnique({ where: { id } })).status;

/** Hilltop applies to `unit`, Lou reviews it and makes an offer. Returns the application id. */
async function offerTo(w, unit, applicant = w.amy, group = w.group) {
  const id = (await applyAs(applicant, unit.id, group.id)).body.application.id;
  expect((await act(w.lou, id, 'start-review')).status).toBe(200);
  expect((await act(w.lou, id, 'offer', { offerDays: 3 })).status).toBe(200);
  return id;
}

/** Wipe applications and make the unit available again (for repeated race rounds). */
async function resetRound(unitId) {
  await prisma.applicationEvent.deleteMany();
  await prisma.application.deleteMany();
  await prisma.unit.update({ where: { id: unitId }, data: { status: 'AVAILABLE' } });
}

describe('accepting an offer', () => {
  it('leases the unit, accepts the application, and writes the event', async () => {
    const { amy, unit, appId } = await offeredWorld();
    const before = await amy.get(`/api/applications/${appId}`);
    expect(before.body.application.viewer.moves.map((m) => m.slug)).toEqual(['accept', 'decline']);

    const res = await acceptAs(amy, appId);
    expect(res.status).toBe(200);
    expect(res.body.application).toMatchObject({ status: 'ACCEPTED', unitId: unit.id, closed: 0 });
    expect(await unitStatus(unit.id)).toBe('LEASED');
    expect((await events(appId)).at(-1)).toMatchObject({
      actorId: amy.user.id,
      actorType: 'GROUP_MEMBER',
      fromStatus: 'OFFERED',
      toStatus: 'ACCEPTED',
    });
    const after = await amy.get(`/api/applications/${appId}`);
    expect(after.body.application.viewer.moves).toEqual([]); // finished
  });

  it('the page button works (HTML form → back to the application)', async () => {
    const { ben, unit, appId } = await offeredWorld();
    const page = await ben.get(`/applications/${appId}`);
    expect(page.text).toContain(`/applications/${appId}/accept`);
    const res = await postForm(
      ben.agent,
      `/applications/${appId}/accept`,
      {},
      {
        tokenFrom: `/applications/${appId}`,
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/applications/${appId}`);
    expect(await unitStatus(unit.id)).toBe('LEASED');
  });

  it("closes the unit's other open applications and the group's other open applications, each with a reason", async () => {
    const w = await offeredWorld();
    const { amy, lou, lia, unit, group, appId } = w;

    // Another group (Y) applied to the same unit.
    const cal = await person('cal@scu.edu', 'STUDENT');
    const y = await makeGroup('Second', [cal.user]);
    const yApp = (await applyAs(cal, unit.id, y.id)).body.application.id;

    // Hilltop's other applications: one submitted (Lia's unit), one with an offer
    // (Lou's unit 3B), and one already rejected (must be left alone).
    const liaUnit = await makeUnit(lia.user.id, { label: '1A' });
    const submittedElsewhere = (await applyAs(amy, liaUnit.id, group.id)).body.application.id;
    const unit3 = await makeUnit(lou.user.id, { label: '3B' });
    const offeredElsewhere = await offerTo(w, unit3);
    const unit4 = await makeUnit(lou.user.id, { label: '4C' });
    const rejected = (await applyAs(amy, unit4.id, group.id)).body.application.id;
    await act(lou, rejected, 'reject', { comment: 'Not this time.' });

    const res = await acceptAs(amy, appId);
    expect(res.status).toBe(200);
    expect(res.body.application.closed).toBe(3);

    for (const [id, reason, from] of [
      [yApp, CLOSE_REASON_UNIT_LEASED, 'SUBMITTED'],
      [submittedElsewhere, CLOSE_REASON_GROUP_PLACED, 'SUBMITTED'],
      [offeredElsewhere, CLOSE_REASON_GROUP_PLACED, 'OFFERED'],
    ]) {
      expect(await statusOf(id)).toBe('CLOSED');
      expect((await events(id)).at(-1)).toMatchObject({
        actorType: 'SYSTEM',
        actorId: null,
        fromStatus: from,
        toStatus: 'CLOSED',
        comment: reason,
      });
    }
    expect(CLOSE_REASON_UNIT_LEASED).toBe('This unit was leased to another group');
    expect(CLOSE_REASON_GROUP_PLACED).toBe('Your group accepted another place');
    expect(await statusOf(rejected)).toBe('REJECTED'); // already finished: untouched
    expect((await events(rejected)).at(-1).toStatus).toBe('REJECTED');
    expect(await unitStatus(unit3.id)).toBe('AVAILABLE'); // only the accepted unit is leased
    expect((await cal.get(`/api/applications/${yApp}`)).body.application.statusLabel).toBe(
      'Closed',
    );

    // A placed group can't open new applications.
    const unit5 = await makeUnit(lou.user.id, { label: '5D' });
    const again = await applyAs(amy, unit5.id, group.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('GROUP_ALREADY_PLACED');
  });
});

describe('races (each run several times; checks hold whoever wins)', () => {
  it('two members accept at the same moment: exactly one succeeds', async () => {
    const w = await offeredWorld();
    for (let round = 1; round <= 5; round += 1) {
      if (round > 1) await resetRound(w.unit.id);
      const id = round === 1 ? w.appId : await offerTo(w, w.unit);
      const results = await Promise.all([acceptAs(w.amy, id), acceptAs(w.ben, id)]);
      expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([200, 409]);
      expect(await unitStatus(w.unit.id)).toBe('LEASED');
      const accepted = await prisma.applicationEvent.count({ where: { toStatus: 'ACCEPTED' } });
      expect(accepted).toBe(1);
    }
  }, 60_000);

  it('accept vs. the landlord rescinding: exactly one wins, the other gets 409', async () => {
    const w = await offeredWorld();
    const tally = { acceptFirst: 0, rescindFirst: 0 };
    for (let round = 1; round <= 6; round += 1) {
      if (round > 1) await resetRound(w.unit.id);
      const id = round === 1 ? w.appId : await offerTo(w, w.unit);
      // Accept takes the group, unit, and application locks (plus re-checks) before it
      // reaches the application row; rescind only locks the row. A rotating delay on the
      // rescind keeps the two overlapping but lets either one win.
      const delay = RESCIND_DELAYS_MS[(round - 1) % RESCIND_DELAYS_MS.length];
      const [acc, resc] = await Promise.all([
        acceptAs(w.amy, id),
        sleep(delay).then(() => act(w.lou, id, 'rescind')),
      ]);
      const label = `round ${round}: accept ${acc.status}, rescind ${resc.status}`;
      expect([acc.status, resc.status].sort(), label).toEqual([200, 409]);
      if (acc.status === 200) {
        tally.acceptFirst += 1;
        expect(await statusOf(id), label).toBe('ACCEPTED');
        expect(await unitStatus(w.unit.id), label).toBe('LEASED');
      } else {
        tally.rescindFirst += 1;
        expect(await statusOf(id), label).toBe('UNDER_REVIEW');
        expect(await unitStatus(w.unit.id), label).toBe('AVAILABLE');
      }
    }
    console.info('accept vs. rescind:', tally);
  }, 60_000);

  it("accept vs. another group's apply to the same unit: no open application is left on a leased unit", async () => {
    const w = await offeredWorld();
    const cal = await person('cal@scu.edu', 'STUDENT');
    const y = await makeGroup('Second', [cal.user]);
    const tally = { applyFirst: 0, acceptFirst: 0 };
    for (let round = 1; round <= 6; round += 1) {
      if (round > 1) await resetRound(w.unit.id);
      const id = round === 1 ? w.appId : await offerTo(w, w.unit);
      const [acc, app] = await Promise.all([acceptAs(w.amy, id), applyAs(cal, w.unit.id, y.id)]);
      const label = `round ${round}: accept ${acc.status}, apply ${app.status}`;
      expect(acc.status, label).toBe(200);
      if (app.status === 201) {
        tally.applyFirst += 1; // the apply committed first, so accept closed it
        const yApp = app.body.application.id;
        expect(await statusOf(yApp), label).toBe('CLOSED');
        expect((await events(yApp)).at(-1).comment, label).toBe(CLOSE_REASON_UNIT_LEASED);
      } else {
        tally.acceptFirst += 1;
        expect(app.status, label).toBe(409);
        expect(app.body.error.code, label).toBe('UNIT_NOT_AVAILABLE');
      }
      const openOnUnit = await prisma.application.count({
        where: {
          unitId: w.unit.id,
          status: { in: ['SUBMITTED', 'DOCS_REQUESTED', 'UNDER_REVIEW', 'OFFERED'] },
        },
      });
      expect(openOnUnit, label).toBe(0);
    }
    console.info('accept vs. apply:', tally);
  }, 60_000);
});

describe('the deadline', () => {
  it('exactly at the deadline: refused (409) and the offer stays EXPIRED', async () => {
    const { amy, unit, appId } = await offeredWorld();
    const { offerExpiresAt } = await prisma.application.findUnique({ where: { id: appId } });
    await expect(accept(amy.user, appId, offerExpiresAt)).rejects.toMatchObject({ status: 409 });
    expect(await statusOf(appId)).toBe('EXPIRED');
    const system = (await events(appId)).filter((e) => e.actorType === 'SYSTEM');
    expect(system).toHaveLength(1);
    expect(await unitStatus(unit.id)).toBe('AVAILABLE');
  });

  it('1 ms before the deadline: accepted', async () => {
    const { amy, unit, appId } = await offeredWorld();
    const { offerExpiresAt } = await prisma.application.findUnique({ where: { id: appId } });
    const result = await accept(amy.user, appId, new Date(offerExpiresAt.getTime() - 1));
    expect(result.status).toBe('ACCEPTED');
    expect(await unitStatus(unit.id)).toBe('LEASED');
  });

  it('over HTTP, a past deadline gets 409 and the offer stays EXPIRED', async () => {
    const { amy, appId } = await offeredWorld();
    await prisma.application.update({
      where: { id: appId },
      data: { offerExpiresAt: new Date(Date.now() - 1000) },
    });
    const res = await acceptAs(amy, appId);
    expect(res.status).toBe(409);
    expect(await statusOf(appId)).toBe('EXPIRED');
  });
});

describe('re-checks at accept time', () => {
  it('a group that grew since applying and no longer fits gets 409; nothing changes', async () => {
    const { amy, unit, group, appId } = await offeredWorld(); // unit fits 4, group has 2
    for (const email of ['cal@scu.edu', 'dee@scu.edu', 'eve@scu.edu']) {
      const u = await createUser({ email, role: 'STUDENT' });
      await prisma.groupMember.create({ data: { groupId: group.id, userId: u.id, term: TERM } });
    }
    const res = await acceptAs(amy, appId);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'GROUP_TOO_BIG',
      message: 'This unit fits 4 people, but the group has 5.',
    });
    expect(await statusOf(appId)).toBe('OFFERED');
    expect(await unitStatus(unit.id)).toBe('AVAILABLE');
  });

  it('a group with someone newly invited (not ready) gets 409', async () => {
    const { amy, group, appId } = await offeredWorld();
    await prisma.groupInvitation.create({
      data: { groupId: group.id, email: 'new@scu.edu', invitedById: amy.user.id },
    });
    expect((await acceptAs(amy, appId)).body.error.code).toBe('GROUP_NOT_READY');
    expect(await statusOf(appId)).toBe('OFFERED');
  });

  it('a unit that is already leased gets 409', async () => {
    const { amy, unit, appId } = await offeredWorld();
    await prisma.unit.update({ where: { id: unit.id }, data: { status: 'LEASED' } });
    expect((await acceptAs(amy, appId)).body.error.code).toBe('UNIT_NOT_AVAILABLE');
    expect(await statusOf(appId)).toBe('OFFERED');
  });

  it("a landlord whose account is no longer ACTIVE: 409, and the unit isn't leased", async () => {
    const { amy, lou, unit, appId } = await offeredWorld();
    await prisma.user.update({ where: { id: lou.user.id }, data: { status: 'PENDING' } });
    const res = await acceptAs(amy, appId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LANDLORD_NOT_ACTIVE');
    expect(await statusOf(appId)).toBe('OFFERED');
    expect(await unitStatus(unit.id)).toBe('AVAILABLE');
  });
});

describe('who can accept', () => {
  it('an outsider student gets 404; a landlord and an admin get 403', async () => {
    const { sam, lou, unit, appId } = await offeredWorld();
    expect((await acceptAs(sam, appId)).status).toBe(404);
    expect((await acceptAs(lou, appId)).status).toBe(403);
    const admin = await person('admin@scu.edu', 'ADMIN');
    expect((await acceptAs(admin, appId)).status).toBe(403);
    // And past the route checks, the service refuses them too.
    await expect(accept(lou.user, appId)).rejects.toMatchObject({ status: 403 });
    await expect(accept(admin.user, appId)).rejects.toMatchObject({ status: 403 });
    await expect(accept(sam.user, appId)).rejects.toMatchObject({ status: 404 });
    expect(await statusOf(appId)).toBe('OFFERED');
    expect(await unitStatus(unit.id)).toBe('AVAILABLE');
  });

  it('a bad id gets 400, a missing one 404; accepting something not offered gets 409', async () => {
    const w = await offeredWorld();
    expect((await acceptAs(w.amy, 'not-a-uuid')).status).toBe(400);
    expect((await acceptAs(w.amy, MISSING_ID)).status).toBe(404);
    const unit2 = await makeUnit(w.lou.user.id, { label: '9Z' });
    const submitted = (await applyAs(w.amy, unit2.id, w.group.id)).body.application.id;
    const res = await acceptAs(w.amy, submitted);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('An application can\'t go from "Submitted" to "Accepted".');
  });
});
