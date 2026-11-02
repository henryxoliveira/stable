/**
 * HTTP helpers built on Supertest. Each `newAgent()` is like a separate
 * browser: it keeps its own cookies, so tests can act as Student A,
 * Landlord B, etc. at the same time.
 */
import request from 'supertest';
import { createApp } from '../../src/app.js';

export const app = createApp();
export const DEFAULT_PASSWORD = 'correct-horse-battery';

export function newAgent() {
  return request.agent(app);
}

/** Load a page that has a form and pull out its hidden CSRF token. */
export async function getCsrfToken(agent, path = '/login') {
  const res = await agent.get(path);
  const match = res.text.match(/name="_csrf" value="([^"]+)"/);
  if (!match) throw new Error(`No CSRF token found on ${path} (status ${res.status})`);
  return match[1];
}

/** POST a form the way a browser would, including the CSRF token. */
export async function postForm(agent, path, fields, { tokenFrom = '/login' } = {}) {
  const _csrf = await getCsrfToken(agent, tokenFrom);
  return agent
    .post(path)
    .type('form')
    .send({ ...fields, _csrf });
}

export function register(agent, { email, password = DEFAULT_PASSWORD, role = 'STUDENT' }) {
  return postForm(agent, '/register', { email, password, role }, { tokenFrom: '/register' });
}

export function login(agent, email, password = DEFAULT_PASSWORD) {
  return postForm(agent, '/login', { email, password });
}

/** Log out, taking the CSRF token from the user's own dashboard page. */
export async function logout(agent) {
  const redirect = await agent.get('/dashboard'); // → /dashboard/<role>
  return postForm(agent, '/logout', {}, { tokenFrom: redirect.headers.location });
}
