/**
 * Shared setup for the application tests (B3, B5). Users, groups, and units are
 * inserted directly (B1 and A2 test those flows through the UI); everything about
 * applications goes through HTTP with one logged-in agent per person.
 */
import { expect } from 'vitest';
import { createUser, prisma } from './db.js';
import { getCsrfToken, login, newAgent } from './http.js';
import { upcomingTerms } from '../../src/services/group.service.js';

export const [TERM, NEXT_TERM] = upcomingTerms();
export const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const TOKEN_PAGE = {
  STUDENT: '/applications',
  LANDLORD: '/dashboard/landlord',
  ADMIN: '/dashboard/admin',
};

/** A logged-in person with a cached CSRF token (csrf-sync keeps one per session). */
export async function person(email, role, status = 'ACTIVE') {
  const user = await createUser({ email, role, status });
  const agent = newAgent();
  await login(agent, email);
  const token = await getCsrfToken(
    agent,
    status === 'PENDING' ? '/dashboard/landlord' : TOKEN_PAGE[role],
  );
  const post = (path, body = {}) =>
    agent.post(path).set('x-csrf-token', token).set('Accept', 'application/json').send(body);
  return { user, agent, post, get: (path) => agent.get(path) };
}

export async function makeUnit(
  ownerId,
  { beds = 4, bedrooms = 2, label = '2B', status = 'AVAILABLE' } = {},
) {
  const property = await prisma.property.create({
    data: {
      ownerId,
      name: 'Franklin House',
      address: '1 Franklin St',
      city: 'Santa Clara',
      postalCode: '95050',
    },
  });
  return prisma.unit.create({
    data: {
      propertyId: property.id,
      label,
      bedrooms,
      beds,
      bathrooms: 1,
      rentCents: 400000,
      status,
    },
  });
}

/** A group (default term TERM) with the given accepted members (first = owner) and pending invites. */
export async function makeGroup(name, members, pendingEmails = [], term = TERM) {
  const group = await prisma.roommateGroup.create({
    data: { name, term, ownerId: members[0].id },
  });
  for (const m of members) {
    await prisma.groupMember.create({ data: { groupId: group.id, userId: m.id, term } });
  }
  for (const email of pendingEmails) {
    await prisma.groupInvitation.create({
      data: { groupId: group.id, email, invitedById: members[0].id },
    });
  }
  return group;
}

/** Amy + Ben (group "Hilltop"), Sam (outsider), Lou (landlord, owns unit 2B), Lia (another landlord). */
export async function world() {
  const [amy, ben, sam, lou, lia] = await Promise.all([
    person('amy@scu.edu', 'STUDENT'),
    person('ben@scu.edu', 'STUDENT'),
    person('sam@scu.edu', 'STUDENT'),
    person('lou@example.com', 'LANDLORD'),
    person('lia@example.com', 'LANDLORD'),
  ]);
  const unit = await makeUnit(lou.user.id);
  const group = await makeGroup('Hilltop', [amy.user, ben.user]);
  return { amy, ben, sam, lou, lia, unit, group };
}

export const applyAs = (p, unitId, groupId) =>
  p.post(`/api/units/${unitId}/applications`, { groupId });
export const act = (p, appId, slug, body = {}) =>
  p.post(`/api/applications/${appId}/${slug}`, body);
export const events = (applicationId) =>
  prisma.applicationEvent.findMany({ where: { applicationId }, orderBy: { createdAt: 'asc' } });

export async function appliedWorld() {
  const w = await world();
  const res = await applyAs(w.amy, w.unit.id, w.group.id);
  expect(res.status).toBe(201);
  return { ...w, appId: res.body.application.id };
}

export async function offeredWorld() {
  const w = await appliedWorld();
  expect((await act(w.lou, w.appId, 'start-review')).status).toBe(200);
  expect((await act(w.lou, w.appId, 'offer', { offerDays: 3 })).status).toBe(200);
  return w;
}
