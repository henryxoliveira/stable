/**
 * Properties, units, floor plans (A2): multi-account workflows, ownership
 * (404 for other landlords), role checks (403 for students, admin writes),
 * invalid input, and computed values (money in cents).
 * Each newAgent() is a separate browser, i.e. a separate person.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, prisma, resetDb } from './helpers/db.js';
import { getCsrfToken, login, newAgent, postForm, postJson, register } from './helpers/http.js';

beforeEach(resetDb);

const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const LANDLORD_PAGE = '/dashboard/landlord';

const PROPERTY = {
  name: 'The Franklin House',
  address: '1234 Franklin St',
  city: 'Santa Clara',
  state: 'ca',
  postalCode: '95050',
  latitude: '37.3496',
  longitude: '-121.9390',
  description: 'Five minutes from campus.',
};

const UNIT = {
  label: 'Unit 2B',
  bedrooms: '2',
  beds: '3',
  bathrooms: '1.5',
  squareFeet: '850',
  rent: '$2,400.50',
  utilities: '',
  parking: '75',
};

// --- helpers -----------------------------------------------------------------

/** Register a landlord through the form (PENDING) and return their agent. */
async function landlord(email) {
  const agent = newAgent();
  expect((await register(agent, { email, role: 'LANDLORD' })).status).toBe(302);
  return agent;
}

async function loggedIn(email, role) {
  await createUser({ email, role });
  const agent = newAgent();
  expect((await login(agent, email)).status).toBe(302);
  return agent;
}

/** JSON POST as a landlord (CSRF token from their dashboard). */
const lpost = (agent, path, body) => postJson(agent, path, body, { tokenFrom: LANDLORD_PAGE });
/** Browser form POST as a landlord. */
const lform = (agent, path, fields) => postForm(agent, path, fields, { tokenFrom: LANDLORD_PAGE });

async function createProperty(agent, overrides = {}) {
  const res = await lpost(agent, '/properties', { ...PROPERTY, ...overrides });
  expect(res.status).toBe(201);
  return res.body.property.id;
}

async function createUnit(agent, propertyId, overrides = {}) {
  const res = await lpost(agent, `/properties/${propertyId}/units`, { ...UNIT, ...overrides });
  expect(res.status).toBe(201);
  return res.body.unit.id;
}

async function createFloorPlan(agent, unitId, overrides = {}) {
  const res = await lpost(agent, `/units/${unitId}/floor-plans`, {
    name: 'Main floor',
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.floorPlan.id;
}

// --- workflow -------------------------------------------------------------------

describe('landlord sets up a property', () => {
  it('a pending landlord adds a property, a unit, and a floor plan through the forms', async () => {
    const lena = await landlord('lena@example.com');

    const created = await lform(lena, '/properties', PROPERTY);
    expect(created.status).toBe(302);
    const propertyId = created.headers.location.split('/').pop();
    expect(created.headers.location).toBe(`/properties/${propertyId}`);

    const unitRes = await lform(lena, `/properties/${propertyId}/units`, UNIT);
    expect(unitRes.status).toBe(302);
    expect(unitRes.headers.location).toBe(`/properties/${propertyId}`);
    const unit = await prisma.unit.findFirst({ where: { propertyId } });

    const planRes = await lform(lena, `/units/${unit.id}/floor-plans`, {
      name: 'Main floor',
      squareFeet: '850',
      notes: 'Both bedrooms upstairs.',
    });
    expect(planRes.status).toBe(302);
    expect(planRes.headers.location).toBe(`/properties/${propertyId}`);

    const page = await lena.get(`/properties/${propertyId}`);
    expect(page.status).toBe(200);
    for (const text of ['The Franklin House', 'Unit 2B', '$2,400.50', '$75.00', 'Main floor']) {
      expect(page.text).toContain(text);
    }
    expect((await lena.get('/properties')).text).toContain('The Franklin House');
  });

  it('saves clean values: state uppercased, money in cents, blank utilities = 0, unit AVAILABLE', async () => {
    const lena = await landlord('lena@example.com');
    const propertyId = await createProperty(lena);
    const unitId = await createUnit(lena, propertyId);

    const property = await prisma.property.findUnique({ where: { id: propertyId } });
    expect(property).toMatchObject({ state: 'CA', latitude: 37.3496, longitude: -121.939 });
    const unit = await prisma.unit.findUnique({ where: { id: unitId } });
    expect(unit).toMatchObject({
      bedrooms: 2,
      beds: 3,
      bathrooms: 1.5,
      squareFeet: 850,
      rentCents: 240050,
      utilitiesCents: 0,
      parkingCents: 7500,
      status: 'AVAILABLE',
    });
  });

  it('the owner edits all three; clearing an optional box clears it', async () => {
    const lena = await landlord('lena@example.com');
    const propertyId = await createProperty(lena);
    const unitId = await createUnit(lena, propertyId);
    const planId = await createFloorPlan(lena, unitId, { notes: 'old' });

    // The edit pages show the saved values (money back in dollars).
    expect((await lena.get(`/properties/${propertyId}/edit`)).text).toContain('1234 Franklin St');
    expect((await lena.get(`/units/${unitId}/edit`)).text).toContain('value="2400.50"');
    expect((await lena.get(`/floor-plans/${planId}/edit`)).status).toBe(200);
    expect((await lena.get(`/properties/${propertyId}/units/new`)).status).toBe(200);
    expect((await lena.get(`/units/${unitId}/floor-plans/new`)).status).toBe(200);
    expect((await lena.get('/properties/new')).status).toBe(200);

    const p = await lform(lena, `/properties/${propertyId}`, {
      ...PROPERTY,
      name: 'Franklin House',
      latitude: '',
      longitude: '',
      description: '',
    });
    expect(p.status).toBe(302);
    expect(await prisma.property.findUnique({ where: { id: propertyId } })).toMatchObject({
      name: 'Franklin House',
      latitude: null,
      longitude: null,
      description: null,
    });

    expect(
      (await lpost(lena, `/units/${unitId}`, { ...UNIT, rent: '2500', squareFeet: '' })).status,
    ).toBe(200);
    expect(await prisma.unit.findUnique({ where: { id: unitId } })).toMatchObject({
      rentCents: 250000,
      squareFeet: null,
    });

    const plan = await lform(lena, `/floor-plans/${planId}`, { name: 'Upstairs', notes: '' });
    expect(plan.headers.location).toBe(`/properties/${propertyId}`);
    expect(await prisma.floorPlan.findUnique({ where: { id: planId } })).toMatchObject({
      name: 'Upstairs',
      notes: null,
    });
  });

  it('duplicate unit labels and floor plan names in the same place are 409; elsewhere is fine', async () => {
    const lena = await landlord('lena@example.com');
    const a = await createProperty(lena);
    const b = await createProperty(lena, { name: 'Second house' });
    const unitA = await createUnit(lena, a);
    await createUnit(lena, b); // same label, different property
    const unitA2 = await createUnit(lena, a, { label: 'Unit 3A' });

    const dupUnit = await lpost(lena, `/properties/${a}/units`, UNIT);
    expect(dupUnit.status).toBe(409);
    expect(dupUnit.body.error.code).toBe('UNIT_LABEL_TAKEN');
    const rename = await lpost(lena, `/units/${unitA2}`, UNIT); // rename onto an existing label
    expect(rename.body.error.code).toBe('UNIT_LABEL_TAKEN');

    await createFloorPlan(lena, unitA);
    await createFloorPlan(lena, unitA2); // same name, different unit
    const dupPlan = await lpost(lena, `/units/${unitA}/floor-plans`, { name: 'Main floor' });
    expect(dupPlan.status).toBe(409);
    expect(dupPlan.body.error.code).toBe('FLOOR_PLAN_NAME_TAKEN');

    // HTML form: the message is shown on the form, with what was typed.
    const page = await lform(lena, `/properties/${a}/units`, UNIT);
    expect(page.status).toBe(409);
    expect(page.text).toContain('already has a unit with that label');
    expect(page.text).toContain('value="Unit 2B"');
    expect(await prisma.unit.count()).toBe(3);
  });

  it('data is still there for a new login (persistence)', async () => {
    const lena = await landlord('lena@example.com');
    const propertyId = await createProperty(lena);
    await createUnit(lena, propertyId);

    const again = newAgent();
    await login(again, 'lena@example.com');
    const { property } = (await again.get(`/api/properties/${propertyId}`)).body;
    expect(property.name).toBe('The Franklin House');
    expect(property.units.map((u) => u.rentCents)).toEqual([240050]);
  });
});

// --- invalid input -------------------------------------------------------------

describe('invalid input', () => {
  it('property: missing fields, bad ZIP and state, half a location, out-of-range coordinates', async () => {
    const lena = await landlord('lena@example.com');
    const cases = [
      [{ name: '' }, 'name'],
      [{ address: '   ' }, 'address'],
      [{ postalCode: '9505' }, 'postalCode'],
      [{ state: 'Calif' }, 'state'],
      [{ longitude: '' }, 'longitude'],
      [{ latitude: '', longitude: '-121.9' }, 'latitude'],
      [{ latitude: '91' }, 'latitude'],
      [{ longitude: 'west' }, 'longitude'],
      [{ description: 'x'.repeat(1001) }, 'description'],
    ];
    for (const [overrides, field] of cases) {
      const res = await lpost(lena, '/properties', { ...PROPERTY, ...overrides });
      expect(res.status, field).toBe(400);
      expect(Object.keys(res.body.error.details), JSON.stringify(overrides)).toContain(field);
    }
    expect(await prisma.property.count()).toBe(0);
  });

  it('unit: beds 0 or 17, half beds, 1.3 baths, negative or huge or malformed rent', async () => {
    const lena = await landlord('lena@example.com');
    const propertyId = await createProperty(lena);
    const cases = [
      [{ beds: '0' }, 'beds'],
      [{ beds: '17' }, 'beds'],
      [{ beds: '2.5' }, 'beds'],
      [{ bedrooms: 'two' }, 'bedrooms'],
      [{ bedrooms: '-1' }, 'bedrooms'],
      [{ bathrooms: '1.3' }, 'bathrooms'],
      [{ rent: '' }, 'rent'],
      [{ rent: '-100' }, 'rent'],
      [{ rent: '100000.01' }, 'rent'],
      [{ rent: '24,00' }, 'rent'],
      [{ parking: '12.345' }, 'parking'],
      [{ squareFeet: '0' }, 'squareFeet'],
      [{ label: '' }, 'label'],
    ];
    for (const [overrides, field] of cases) {
      const res = await lpost(lena, `/properties/${propertyId}/units`, { ...UNIT, ...overrides });
      expect(res.status, field).toBe(400);
      expect(Object.keys(res.body.error.details), JSON.stringify(overrides)).toContain(field);
    }
    expect(await prisma.unit.count()).toBe(0);
  });

  it('a studio (0 bedrooms, 1 bed) and $0 utilities are fine; JSON numbers work too', async () => {
    const lena = await landlord('lena@example.com');
    const propertyId = await createProperty(lena);
    const res = await lpost(lena, `/properties/${propertyId}/units`, {
      label: 'Studio',
      bedrooms: 0,
      beds: 1,
      bathrooms: 1,
      rent: 1850,
      utilities: 0,
    });
    expect(res.status).toBe(201);
    expect(res.body.unit).toMatchObject({ rentCents: 185000, utilitiesCents: 0, parkingCents: 0 });
  });

  it('the HTML form shows field errors and keeps what was typed', async () => {
    const lena = await landlord('lena@example.com');
    const propertyId = await createProperty(lena);
    const res = await lform(lena, `/properties/${propertyId}/units`, { ...UNIT, beds: '40' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Beds must be at most 16.');
    expect(res.text).toContain('value="$2,400.50"');
  });

  it('malformed ids are 400; unknown ids are 404', async () => {
    const lena = await landlord('lena@example.com');
    expect((await lena.get('/properties/not-a-uuid')).status).toBe(400);
    expect((await lena.get(`/properties/${MISSING_ID}`)).status).toBe(404);
    expect((await lpost(lena, `/properties/${MISSING_ID}/units`, UNIT)).status).toBe(404);
    expect((await lpost(lena, `/units/${MISSING_ID}/floor-plans`, { name: 'x' })).status).toBe(404);
    expect((await lena.get(`/floor-plans/${MISSING_ID}/edit`)).status).toBe(404);
  });
});

// --- authorization -------------------------------------------------------------

describe('authorization', () => {
  /** Lena owns a property with a unit and a floor plan. */
  async function lenasThings() {
    const lena = await landlord('lena@example.com');
    const propertyId = await createProperty(lena);
    const unitId = await createUnit(lena, propertyId);
    const planId = await createFloorPlan(lena, unitId);
    return { lena, propertyId, unitId, planId };
  }

  const readPaths = ({ propertyId }) => [
    `/properties/${propertyId}`,
    `/api/properties/${propertyId}`,
  ];
  const editPages = ({ propertyId, unitId, planId }) => [
    `/properties/${propertyId}/edit`,
    `/properties/${propertyId}/units/new`,
    `/units/${unitId}/edit`,
    `/units/${unitId}/floor-plans/new`,
    `/floor-plans/${planId}/edit`,
  ];
  const writes = ({ propertyId, unitId, planId }) => [
    [`/properties/${propertyId}`, { ...PROPERTY, name: 'Hijacked' }],
    [`/properties/${propertyId}/units`, { ...UNIT, label: 'Extra' }],
    [`/units/${unitId}`, { ...UNIT, rent: '1' }],
    [`/units/${unitId}/floor-plans`, { name: 'Extra' }],
    [`/floor-plans/${planId}`, { name: 'Hijacked' }],
  ];

  async function expectUnchanged({ propertyId, unitId, planId }) {
    expect((await prisma.property.findUnique({ where: { id: propertyId } })).name).toBe(
      PROPERTY.name,
    );
    expect((await prisma.unit.findUnique({ where: { id: unitId } })).rentCents).toBe(240050);
    expect((await prisma.floorPlan.findUnique({ where: { id: planId } })).name).toBe('Main floor');
    expect(await prisma.unit.count()).toBe(1);
    expect(await prisma.floorPlan.count()).toBe(1);
  }

  it('another landlord gets 404 on every page and action, and sees none of it in their list', async () => {
    const things = await lenasThings();
    const omar = await landlord('omar@example.com');

    for (const path of [...readPaths(things), ...editPages(things)]) {
      expect((await omar.get(path)).status, path).toBe(404);
    }
    for (const [path, body] of writes(things)) {
      expect((await lpost(omar, path, body)).status, path).toBe(404);
    }
    expect((await omar.get('/api/properties')).body.properties).toEqual([]);
    expect((await omar.get('/properties')).text).not.toContain(PROPERTY.name);
    await expectUnchanged(things);
  });

  it('students get 403 on everything, including the list and the new form', async () => {
    const things = await lenasThings();
    const student = newAgent();
    expect((await register(student, { email: 'sam@scu.edu' })).status).toBe(302);

    for (const path of [
      '/properties',
      '/api/properties',
      '/properties/new',
      ...readPaths(things),
      ...editPages(things),
    ]) {
      expect((await student.get(path)).status, path).toBe(403);
    }
    const token = await getCsrfToken(student, '/dashboard/student');
    for (const [path, body] of [['/properties', PROPERTY], ...writes(things)]) {
      const res = await student
        .post(path)
        .set('x-csrf-token', token)
        .set('Accept', 'application/json')
        .send(body);
      expect(res.status, path).toBe(403);
    }
    await expectUnchanged(things);
  });

  it("an admin can view every landlord's properties but gets 403 on every edit", async () => {
    const things = await lenasThings();
    const omar = await landlord('omar@example.com');
    await createProperty(omar, { name: 'Omar Flats' });
    const admin = await loggedIn('admin@scu.edu', 'ADMIN');

    const list = await admin.get('/api/properties');
    expect(list.body.properties.map((p) => p.name).sort()).toEqual(['Omar Flats', PROPERTY.name]);
    const page = await admin.get(`/properties/${things.propertyId}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('lena@example.com'); // owner shown to admins
    expect(page.text).not.toContain('Edit property'); // no edit buttons

    for (const path of ['/properties/new', ...editPages(things)]) {
      expect((await admin.get(path)).status, path).toBe(403);
    }
    const token = await getCsrfToken(admin, '/dashboard/admin');
    for (const [path, body] of [['/properties', PROPERTY], ...writes(things)]) {
      const res = await admin
        .post(path)
        .set('x-csrf-token', token)
        .set('Accept', 'application/json')
        .send(body);
      expect(res.status, path).toBe(403);
    }
    await expectUnchanged(things);
  });

  it('anonymous users are sent to login (pages) or get 401 (API)', async () => {
    const anon = newAgent();
    const page = await anon.get('/properties');
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/login');
    expect((await anon.get('/api/properties')).status).toBe(401);
  });

  it('a POST without a CSRF token is refused (403)', async () => {
    const lena = await landlord('lena@example.com');
    const res = await lena.post('/properties').set('Accept', 'application/json').send(PROPERTY);
    expect(res.status).toBe(403);
    expect(await prisma.property.count()).toBe(0);
  });
});
