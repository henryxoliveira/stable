/**
 * Regression tests for the shared validate() middleware when calls are
 * chained (params, then body), as the group routes do. Uses a tiny Express app
 * with the real validate() and the real central error handler; no database.
 */
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { validate } from '../src/middleware/validate.js';
import { errorHandler } from '../src/middleware/errors.js';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

/** Every call the final handler receives, so tests can prove it never ran. */
let handled;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const params = validate(z.object({ id: z.uuid() }), { source: 'params' });
  const handler = (req, res) => {
    handled.push(req.valid);
    res.json({ valid: req.valid });
  };

  // The usual shape: params schema, then a body schema with different keys.
  app.post('/things/:id', params, validate(z.object({ name: z.string().trim().min(1) })), handler);

  // A body schema that ALSO declares `id`, to check the merge can't overwrite it.
  app.post(
    '/overlap/:id',
    params,
    validate(z.object({ id: z.uuid(), name: z.string().trim().min(1) })),
    handler,
  );

  // A body schema whose keys share names with properties every object INHERITS
  // ("toString", "constructor"). These must not be mistaken for earlier keys.
  app.post(
    '/inherited/:id',
    params,
    validate(z.object({ toString: z.string(), constructor: z.string() })),
    handler,
  );

  // An HTML form route whose `view` is a function (the hook groups use).
  app.post(
    '/form/:id',
    params,
    validate(z.object({ name: z.string().trim().min(1), password: z.string().optional() }), {
      view: (req, res, { errors, values }) => res.status(400).json({ hook: true, errors, values }),
    }),
    handler,
  );

  app.use(errorHandler);
  return app;
}

const app = buildApp();
const postJson = (path, body) =>
  request(app).post(path).set('Accept', 'application/json').send(body);

beforeEach(() => {
  handled = [];
});

describe('chained validate(): params then body', () => {
  it('merges both validated results into req.valid (parsed values, e.g. trimmed)', async () => {
    const res = await postJson(`/things/${ID}`, { name: '  Hilltop  ' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toEqual({ id: ID, name: 'Hilltop' });
    expect(handled).toHaveLength(1);
  });

  it('a failing SECOND validator returns 400 with only its own field errors', async () => {
    const res = await postJson(`/things/${ID}`, { name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.error.details)).toEqual(['name']);
    expect(handled).toHaveLength(0);
  });

  it('a failing FIRST validator returns 400 and stops before the body validator', async () => {
    const res = await postJson('/things/not-a-uuid', { name: '   ' });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.details)).toEqual(['id']); // no `name` error: never reached
    expect(handled).toHaveLength(0);
  });

  it('drops unknown body keys, so the body cannot override a param it does not declare', async () => {
    const res = await postJson(`/things/${ID}`, { name: 'Ok', id: OTHER_ID, role: 'ADMIN' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toEqual({ id: ID, name: 'Ok' });
  });

  it('rejects a key declared by both schemas with a different value (400, no overwrite)', async () => {
    const res = await postJson(`/overlap/${ID}`, { id: OTHER_ID, name: 'Ok' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual({ id: expect.stringMatching(/Conflicting values/) });
    expect(handled).toHaveLength(0);
  });

  it('keys named like inherited properties (toString, constructor) are not false conflicts', async () => {
    const ok = await postJson(`/inherited/${ID}`, { toString: 'a', constructor: 'b' });
    expect(ok.status).toBe(200);
    expect(ok.body.valid).toEqual({ id: ID, toString: 'a', constructor: 'b' });

    // A real conflict (an own key with a different value) is still refused.
    const conflict = await postJson(`/overlap/${ID}`, { id: OTHER_ID, name: 'Ok' });
    expect(conflict.status).toBe(400);
    expect(conflict.body.error.details).toEqual({ id: expect.stringMatching(/Conflicting/) });
  });

  it('allows a key declared by both schemas when the values match', async () => {
    const res = await postJson(`/overlap/${ID}`, { id: ID, name: 'Ok' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toEqual({ id: ID, name: 'Ok' });
  });

  it('calls a function `view` for HTML requests, with errors and values (password removed)', async () => {
    const res = await request(app)
      .post(`/form/${ID}`)
      .set('Accept', 'text/html')
      .type('form')
      .send({ name: ' ', password: 'secret-value' });
    expect(res.status).toBe(400);
    expect(res.body.hook).toBe(true);
    expect(Object.keys(res.body.errors)).toEqual(['name']);
    expect(res.body.values).toEqual({ name: ' ' });
    expect(handled).toHaveLength(0);
  });
});
