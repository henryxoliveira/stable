/**
 * Login is required everywhere except the public allow-list, and role /
 * account-status rules are enforced on the server.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, resetDb } from './helpers/db.js';
import { login, newAgent, register } from './helpers/http.js';

beforeEach(resetDb);

const SOME_ID = '00000000-0000-4000-8000-000000000000';

describe('unauthenticated access', () => {
  it('allows only the public allow-list', async () => {
    const anon = newAgent();
    expect((await anon.get('/healthz')).status).toBe(200);
    expect((await anon.get('/login')).status).toBe(200);
    expect((await anon.get('/register')).status).toBe(200);
    expect((await anon.get('/css/styles.css')).status).toBe(200);
  });

  it('redirects pages to /login (even unknown paths, so routes are not revealed)', async () => {
    for (const path of ['/', '/dashboard', '/dashboard/admin', '/does-not-exist']) {
      const res = await newAgent().get(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.location).toBe('/login');
    }
  });

  it('returns 401 with the standard JSON error shape for API routes', async () => {
    const res = await newAgent().get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: 'UNAUTHENTICATED', message: expect.any(String) } });
  });
});

describe('role and status checks', () => {
  it('a student cannot open the admin or landlord dashboards', async () => {
    const student = newAgent();
    await register(student, { email: 'amy@scu.edu' });
    expect((await student.get('/dashboard')).headers.location).toBe('/dashboard/student');
    expect((await student.get('/dashboard/student')).status).toBe(200);
    expect((await student.get('/dashboard/admin')).status).toBe(403);
    expect((await student.get('/dashboard/landlord')).status).toBe(403);
  });

  it('an admin (created outside public registration) reaches the admin dashboard', async () => {
    await createUser({ email: 'housing@scu.edu', role: 'ADMIN' });
    const admin = newAgent();
    await login(admin, 'housing@scu.edu');
    expect((await admin.get('/dashboard/admin')).status).toBe(200);
  });

  it('a PENDING landlord can log in but cannot publish a listing', async () => {
    const landlord = newAgent();
    await register(landlord, { email: 'pending@example.com', role: 'LANDLORD' });
    const page = await landlord.get('/dashboard/landlord');
    expect(page.status).toBe(200);
    expect(page.text).toContain('pending approval');

    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const res = await landlord.post(`/api/listings/${SOME_ID}/submit`).set('x-csrf-token', csrf);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_PENDING');
  });

  it('an ACTIVE landlord passes the status check (feature itself not built yet)', async () => {
    await createUser({ email: 'approved@example.com', role: 'LANDLORD', status: 'ACTIVE' });
    const landlord = newAgent();
    await login(landlord, 'approved@example.com');
    const page = await landlord.get('/dashboard/landlord');
    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const res = await landlord.post(`/api/listings/${SOME_ID}/submit`).set('x-csrf-token', csrf);
    expect(res.status).toBe(501);
  });

  it('validates route params before reaching the controller', async () => {
    await createUser({ email: 'approved@example.com', role: 'LANDLORD' });
    const landlord = newAgent();
    await login(landlord, 'approved@example.com');
    const page = await landlord.get('/dashboard/landlord');
    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const res = await landlord.post('/api/listings/not-a-uuid/submit').set('x-csrf-token', csrf);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
