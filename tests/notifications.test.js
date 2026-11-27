/**
 * In-app notifications (B6 part 1): each trigger notifies exactly the right
 * people (never the person who acted), notifications are written in the same
 * transaction as their event, nobody can see or mark anyone else's, messages are
 * escaped on the page, and links are always internal paths.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, prisma, resetDb } from './helpers/db.js';
import { newAgent, postForm, postJson } from './helpers/http.js';
import {
  MISSING_ID,
  act,
  applyAs,
  appliedWorld,
  makeGroup,
  makeUnit,
  offeredWorld,
  person,
  world,
} from './helpers/applications.js';
import { isInternalPath, notify } from '../src/services/notification.service.js';
import { formatPacific } from '../src/utils/time.js';

beforeEach(resetDb);

/** Every notification, as { to, type, link, message }, sorted by recipient then type. */
async function allNotices() {
  const rows = await prisma.notification.findMany({ include: { user: true } });
  return rows
    .map((n) => ({ to: n.user.email, type: n.type, link: n.link, message: n.message }))
    .sort((a, b) => a.to.localeCompare(b.to) || a.type.localeCompare(b.type));
}

/** Clear notifications, run `fn`, and return only the notifications it created. */
async function noticesFrom(fn) {
  await prisma.notification.deleteMany();
  await fn();
  return allNotices();
}

const who = (notices) => notices.map((n) => `${n.to} ${n.type}`);

describe('who gets notified (triggers)', () => {
  it('a group applying notifies the unit’s landlord only', async () => {
    const w = await world();
    let appId;
    const notices = await noticesFrom(async () => {
      const res = await applyAs(w.amy, w.unit.id, w.group.id);
      expect(res.status).toBe(201);
      appId = res.body.application.id;
    });
    expect(who(notices)).toEqual(['lou@example.com APPLICATION_SUBMITTED']);
    expect(notices[0].link).toBe(`/units/${w.unit.id}/applications`);
    expect(notices[0].message).toBe('Hilltop (2 people) applied for unit 2B at Franklin House.');
    expect(appId).toBeTruthy();
  });

  it('every landlord move notifies each group member, never the landlord', async () => {
    const { ben, lou, appId } = await appliedWorld();
    const groupMembers = (type) => [`amy@scu.edu ${type}`, `ben@scu.edu ${type}`];

    let n = await noticesFrom(async () => {
      const res = await act(lou, appId, 'request-documents', { comment: 'Pay stubs, please.' });
      expect(res.status).toBe(200);
    });
    expect(who(n)).toEqual(groupMembers('DOCUMENTS_REQUESTED'));
    expect(n[0].link).toBe(`/applications/${appId}`);
    expect(n[0].message).toContain('Comment: “Pay stubs, please.”');

    // (the group's reply goes the other way; checked in the next test too)
    expect((await act(ben, appId, 'send-documents', { comment: 'Sent.' })).status).toBe(200);

    n = await noticesFrom(async () => {
      expect((await act(lou, appId, 'start-review')).status).toBe(200);
    });
    expect(who(n)).toEqual(groupMembers('REVIEW_STARTED'));

    let deadline;
    n = await noticesFrom(async () => {
      const res = await act(lou, appId, 'offer', { offerDays: 3 });
      expect(res.status).toBe(200);
      deadline = res.body.application.offerExpiresAt;
    });
    expect(who(n)).toEqual(groupMembers('OFFER_MADE'));
    expect(n[0].message).toContain(`open until ${formatPacific(deadline)}`);

    n = await noticesFrom(async () => {
      expect((await act(lou, appId, 'rescind')).status).toBe(200);
    });
    expect(who(n)).toEqual(groupMembers('OFFER_RESCINDED'));

    n = await noticesFrom(async () => {
      expect((await act(lou, appId, 'reject', { comment: 'Too many applicants.' })).status).toBe(
        200,
      );
    });
    expect(who(n)).toEqual(groupMembers('APPLICATION_REJECTED'));
    expect(n[0].message).toContain('“Too many applicants.”');
  });

  it('send documents, withdraw, and decline notify the landlord only (not the group)', async () => {
    const a = await appliedWorld();
    await act(a.lou, a.appId, 'request-documents', { comment: 'ID please.' });
    let n = await noticesFrom(async () => {
      expect((await act(a.ben, a.appId, 'send-documents', { comment: 'Done.' })).status).toBe(200);
    });
    expect(who(n)).toEqual(['lou@example.com DOCUMENTS_SENT']);
    expect(n[0].link).toBe(`/units/${a.unit.id}/applications`);

    n = await noticesFrom(async () => {
      expect((await act(a.amy, a.appId, 'withdraw')).status).toBe(200);
    });
    expect(who(n)).toEqual(['lou@example.com APPLICATION_WITHDRAWN']);

    await resetDb();
    const o = await offeredWorld();
    n = await noticesFrom(async () => {
      expect((await act(o.ben, o.appId, 'decline')).status).toBe(200);
    });
    expect(who(n)).toEqual(['lou@example.com OFFER_DECLINED']);
  });

  it('accepting notifies the landlord, the rest of the group, and everyone whose application closed', async () => {
    const w = await offeredWorld(); // Hilltop (Amy, Ben) has an offer for Lou's unit 2B
    // Corner (Sam alone) also applied for 2B; Hilltop also applied for Lia's unit 3A.
    const corner = await makeGroup('Corner', [w.sam.user]);
    expect((await applyAs(w.sam, w.unit.id, corner.id)).status).toBe(201);
    const liaUnit = await makeUnit(w.lia.user.id, { label: '3A' });
    expect((await applyAs(w.amy, liaUnit.id, w.group.id)).status).toBe(201);

    const n = await noticesFrom(async () => {
      expect((await w.amy.post(`/api/applications/${w.appId}/accept`)).status).toBe(200);
    });
    expect(who(n)).toEqual([
      'ben@scu.edu APPLICATION_CLOSED', // Hilltop's other application (Lia's 3A)
      'ben@scu.edu OFFER_ACCEPTED', // Amy accepted for the group
      'lia@example.com APPLICATION_CLOSED', // her applicant took another place
      'lou@example.com OFFER_ACCEPTED',
      'sam@scu.edu APPLICATION_CLOSED', // 2B went to another group
    ]);
    // Amy (who accepted) gets nothing; Lou gets no "closed" for his own unit's applications.
    const by = (to, type) => n.find((x) => x.to === to && x.type === type);
    expect(by('sam@scu.edu', 'APPLICATION_CLOSED').message).toContain(
      'was closed: this unit was leased to another group.',
    );
    expect(by('ben@scu.edu', 'APPLICATION_CLOSED').message).toContain(
      'unit 3A at Franklin House was closed: your group accepted another place.',
    );
    expect(by('lia@example.com', 'APPLICATION_CLOSED').link).toBe(
      `/units/${liaUnit.id}/applications`,
    );
    expect(by('ben@scu.edu', 'OFFER_ACCEPTED').message).toContain('amy@scu.edu accepted the offer');
  });

  it('an offer expiring notifies the group and the landlord (the system acted, so nobody is left out)', async () => {
    const w = await offeredWorld();
    await prisma.application.update({
      where: { id: w.appId },
      data: { offerExpiresAt: new Date(Date.now() - 1000) },
    });
    const n = await noticesFrom(async () => {
      expect((await w.lou.get(`/units/${w.unit.id}/applications`)).status).toBe(200); // check-on-read
    });
    expect(who(n)).toEqual([
      'amy@scu.edu OFFER_EXPIRED',
      'ben@scu.edu OFFER_EXPIRED',
      'lou@example.com OFFER_EXPIRED',
    ]);
    expect(n.find((x) => x.to === 'lou@example.com').link).toBe(`/units/${w.unit.id}/applications`);
    expect(n.find((x) => x.to === 'amy@scu.edu').link).toBe(`/applications/${w.appId}`);

    // Reading again doesn't expire (or notify) twice.
    const again = await noticesFrom(() => w.amy.get(`/applications/${w.appId}`));
    expect(again).toEqual([]);
  });

  it('an invite notifies the invited student if they have an account; the owner sees the same response either way', async () => {
    const amy = await person('amy@scu.edu', 'STUDENT');
    await createUser({ email: 'carl@scu.edu', role: 'STUDENT' });
    const group = await makeGroup('Hilltop', [amy.user]);

    let withAccount;
    let n = await noticesFrom(async () => {
      withAccount = await postJson(amy.agent, `/groups/${group.id}/invites`, {
        email: 'carl@scu.edu',
      });
    });
    expect(who(n)).toEqual(['carl@scu.edu GROUP_INVITE']);
    expect(n[0].link).toBe('/groups');
    expect(n[0].message).toMatch(/^amy@scu\.edu invited you to join the roommate group Hilltop \(/);

    let noAccount;
    n = await noticesFrom(async () => {
      noAccount = await postJson(amy.agent, `/groups/${group.id}/invites`, {
        email: 'nobody@scu.edu',
      });
    });
    expect(n).toEqual([]);
    expect(noAccount.status).toBe(withAccount.status);
    expect(Object.keys(noAccount.body)).toEqual(Object.keys(withAccount.body));
  });

  it('a refused move creates no notification', async () => {
    const { lou, sam, appId } = await appliedWorld();
    const n = await noticesFrom(async () => {
      expect((await act(lou, appId, 'rescind')).status).toBe(409); // no offer to rescind
      expect((await act(sam, appId, 'withdraw')).status).toBe(404); // not in the group
    });
    expect(n).toEqual([]);
  });
});

describe('same transaction and internal links', () => {
  it('notifications roll back with the transaction that wrote them', async () => {
    const user = await createUser({ email: 'amy@scu.edu', role: 'STUDENT' });
    const base = { recipientIds: [user.id], type: 'GROUP_INVITE', message: 'Hi', link: '/groups' };
    await expect(
      prisma.$transaction(async (tx) => {
        await notify(tx, base); // written...
        throw new Error('the event failed'); // ...then the transaction is rolled back
      }),
    ).rejects.toThrow('the event failed');
    expect(await prisma.notification.count()).toBe(0);
  });

  it('only internal paths are allowed as links (in code and in the database)', async () => {
    for (const ok of ['/', '/groups', '/applications/abc?x=1#top']) {
      expect(isInternalPath(ok), ok).toBe(true);
    }
    const bad = [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'groups',
      '',
      '/a b',
      '/a\nb',
      null,
    ];
    for (const link of bad) expect(isInternalPath(link), String(link)).toBe(false);

    const user = await createUser({ email: 'amy@scu.edu', role: 'STUDENT' });
    await expect(
      prisma.$transaction((tx) =>
        notify(tx, { recipientIds: [user.id], type: 'GROUP_INVITE', message: 'x', link: '//x' }),
      ),
    ).rejects.toThrow('internal path');
    // Even code that skips notify() can't store one: the CHECK constraint refuses it.
    for (const link of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      await expect(
        prisma.notification.create({
          data: { userId: user.id, type: 'GROUP_INVITE', message: 'x', link },
        }),
      ).rejects.toThrow();
    }
    expect(await prisma.notification.count()).toBe(0);
  });
});

describe('the notifications page, badge, and marking read', () => {
  /** Two notices each for Amy and Ben (documents requested, review started); two for Lou. */
  async function twoNoticesEach() {
    const w = await appliedWorld();
    await act(w.lou, w.appId, 'request-documents', { comment: 'ID please.' });
    await act(w.ben, w.appId, 'send-documents', { comment: 'Sent.' }); // → Lou
    await act(w.lou, w.appId, 'start-review');
    return w;
  }
  const mine = (p) => prisma.notification.findMany({ where: { userId: p.user.id } });

  it('lists my notifications newest first, with the unread count in the header', async () => {
    const { amy, lou } = await twoNoticesEach();
    const page = await amy.get('/notifications');
    expect(page.status).toBe(200);
    const review = page.text.indexOf('started reviewing');
    const docs = page.text.indexOf('asked Hilltop for documents');
    expect(review).toBeGreaterThan(-1);
    expect(docs).toBeGreaterThan(review); // newest first
    expect(page.text).toContain('aria-label="2 unread"');
    expect(page.text).not.toContain('sent the documents'); // Lou's, not Amy's

    const api = await amy.get('/api/notifications');
    expect(api.body.unread).toBe(2);
    expect(api.body.notifications.map((n) => n.type)).toEqual([
      'REVIEW_STARTED',
      'DOCUMENTS_REQUESTED',
    ]);
    expect(api.body.notifications[0]).not.toHaveProperty('userId');
    expect((await lou.get('/api/notifications')).body.unread).toBe(2); // applied + documents sent
  });

  it('a comment containing HTML is shown as text, not markup', async () => {
    const { amy, lou, appId } = await appliedWorld();
    const comment = '<script>alert("x")</script><b>bold</b>';
    expect((await act(lou, appId, 'request-documents', { comment })).status).toBe(200);
    const page = await amy.get('/notifications');
    expect(page.text).not.toContain('<script>alert');
    expect(page.text).not.toContain('<b>bold</b>');
    expect(page.text).toContain(
      '&lt;script&gt;alert(&#34;x&#34;)&lt;/script&gt;&lt;b&gt;bold&lt;/b&gt;',
    );
  });

  it('mark one read (form and API), then mark all: only my own change', async () => {
    const { amy, ben } = await twoNoticesEach();
    const [first, second] = await mine(amy);

    const form = await postForm(
      amy.agent,
      `/notifications/${first.id}/read`,
      {},
      {
        tokenFrom: '/notifications',
      },
    );
    expect(form.status).toBe(302);
    expect(form.headers.location).toBe('/notifications');
    expect((await prisma.notification.findUnique({ where: { id: first.id } })).readAt).not.toBe(
      null,
    );
    expect((await amy.get('/notifications')).text).toContain('aria-label="1 unread"');

    const api = await amy.post(`/api/notifications/${second.id}/read`);
    expect(api.status).toBe(200);
    expect(api.body.notification.readAt).toBeTruthy();
    // Marking again is fine and keeps the first time.
    const again = await amy.post(`/api/notifications/${second.id}/read`);
    expect(again.body.notification.readAt).toBe(api.body.notification.readAt);

    // Ben's are untouched; mark all marks only his.
    expect((await mine(ben)).every((n) => n.readAt === null)).toBe(true);
    const all = await ben.post('/api/notifications/read-all');
    expect(all.body.marked).toBe(2);
    expect((await mine(ben)).every((n) => n.readAt !== null)).toBe(true);
    expect((await ben.get('/notifications')).text).not.toContain('unread"');
    const lou = await prisma.notification.findMany({
      where: { user: { email: 'lou@example.com' } },
    });
    expect(lou.every((n) => n.readAt === null)).toBe(true);

    // The "mark all" form works too.
    const formAll = await postForm(
      amy.agent,
      '/notifications/read-all',
      {},
      {
        tokenFrom: '/notifications',
      },
    );
    expect(formAll.status).toBe(302);
    expect((await mine(amy)).every((n) => n.readAt !== null)).toBe(true);
  });

  it('someone else’s notification is 404 (form and API) and stays unread', async () => {
    const { amy, lou, lia } = await twoNoticesEach();
    const [lous] = await mine(lou);
    expect((await amy.post(`/api/notifications/${lous.id}/read`)).status).toBe(404);
    expect((await lia.post(`/api/notifications/${lous.id}/read`)).status).toBe(404);
    const form = await postForm(
      amy.agent,
      `/notifications/${lous.id}/read`,
      {},
      {
        tokenFrom: '/notifications',
      },
    );
    expect(form.status).toBe(404);
    expect((await amy.post(`/api/notifications/${MISSING_ID}/read`)).status).toBe(404);
    expect((await prisma.notification.findUnique({ where: { id: lous.id } })).readAt).toBe(null);
    expect((await amy.get('/notifications')).text).not.toContain('sent the documents');
  });

  it('rejects invalid input, missing CSRF tokens, and logged-out visitors', async () => {
    const { amy, lou } = await twoNoticesEach();
    const bad = await amy.post('/api/notifications/not-a-uuid/read');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    const [lous] = await mine(lou);
    const noToken = await lou.agent.post(`/notifications/${lous.id}/read`).type('form').send({});
    expect(noToken.status).toBe(403);
    const noTokenAll = await lou.agent.post('/notifications/read-all').type('form').send({});
    expect(noTokenAll.status).toBe(403);
    expect((await mine(lou)).every((n) => n.readAt === null)).toBe(true);

    const anon = newAgent();
    for (const path of ['/notifications', '/api/notifications']) {
      const res = await anon.get(path);
      expect([302, 401], path).toContain(res.status);
    }
    expect((await anon.get('/notifications')).headers.location).toBe('/login');
  });

  it('an admin has an (empty) notifications page and no badge', async () => {
    const admin = await person('ada@example.com', 'ADMIN');
    const page = await admin.get('/notifications');
    expect(page.status).toBe(200);
    expect(page.text).toContain('No notifications yet.');
    expect(page.text).not.toContain('unread"');
  });
});
