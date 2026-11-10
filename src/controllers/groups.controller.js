/**
 * HTTP handlers for roommate groups. Thin: read `req.valid`, call the service,
 * then redirect (HTML forms) or send JSON (API / fetch clients).
 *
 * For HTML forms, a 400/409 from the service re-renders the page with the
 * message instead of showing a bare error page. 403/404 still go to the
 * central error handler, so nothing about the group leaks.
 */
import * as groupService from '../services/group.service.js';
import { HttpError } from '../utils/httpError.js';
import { wantsJson } from '../utils/request.js';

// --- Page renderers (also used to re-render after a form error) ---

/** "FALL-2026" → "Fall 2026" (dropdown label). */
function termLabel(term) {
  const [season, year] = term.split('-');
  return `${season[0]}${season.slice(1).toLowerCase()} ${year}`;
}

async function renderIndex(req, res, { status = 200, errors = {}, values = {} } = {}) {
  const data = await groupService.listMyGroups(req.user);
  const terms = groupService.upcomingTerms().map((value) => ({ value, label: termLabel(value) }));
  res.status(status).render('groups/index', { ...data, terms, errors, values });
}

async function renderShow(req, res, { status = 200, errors = {}, values = {} } = {}) {
  const detail = await groupService.getGroupDetail(req.user, req.valid.id);
  res.status(status).render('groups/show', { detail, errors, values });
}

/** `validate()` hook: show the create form's field errors on the /groups page. */
export const createInvalid = (req, res, { errors, values }) =>
  renderIndex(req, res, { status: 400, errors, values });

/** `validate()` hook: show the invite/transfer field errors on the group page. */
export const groupFormInvalid = (req, res, { errors, values }) =>
  renderShow(req, res, { status: 400, errors, values });

/**
 * Run a service call. On success: JSON clients get `json(result)`, browsers are
 * redirected to `redirectTo(result)`. On a 400/409 a browser gets `rerender`.
 */
async function act(req, res, { run, redirectTo, json, rerender }) {
  try {
    const result = await run();
    if (wantsJson(req)) return res.status(json.status ?? 200).json(json.body(result));
    return res.redirect(redirectTo(result));
  } catch (err) {
    const isFormError = err instanceof HttpError && (err.status === 400 || err.status === 409);
    if (!isFormError || wantsJson(req) || !rerender) throw err;
    const errors = { ...(err.details ?? {}), _form: err.message };
    return rerender(req, res, { status: err.status, errors, values: req.body ?? {} });
  }
}

// --- Reads ---

/** GET /groups: my groups, my invitations, and the create form. */
export const index = (req, res) => renderIndex(req, res);

/** GET /api/groups: the same data as JSON. */
export async function apiIndex(req, res) {
  res.json(await groupService.listMyGroups(req.user));
}

/** GET /groups/:id */
export const show = (req, res) => renderShow(req, res);

/** GET /api/groups/:id */
export async function apiShow(req, res) {
  res.json(await groupService.getGroupDetail(req.user, req.valid.id));
}

// --- Writes ---

/** POST /groups */
export const create = (req, res) =>
  act(req, res, {
    run: () => groupService.createGroup(req.user, req.valid),
    redirectTo: (group) => `/groups/${group.id}`,
    json: {
      status: 201,
      body: (g) => ({ group: { id: g.id, name: g.name, term: g.term, ownerId: g.ownerId } }),
    },
    rerender: renderIndex,
  });

/** POST /groups/:id/invites */
export const invite = (req, res) =>
  act(req, res, {
    run: () => groupService.inviteByEmail(req.user, req.valid.id, req.valid.email),
    redirectTo: () => `/groups/${req.valid.id}`,
    json: { status: 201, body: (inv) => ({ invitation: inv }) },
    rerender: renderShow,
  });

/** POST /groups/:id/invites/:inviteId/cancel */
export const cancelInvite = (req, res) =>
  act(req, res, {
    run: () => groupService.cancelInvite(req.user, req.valid.id, req.valid.inviteId),
    redirectTo: () => `/groups/${req.valid.id}`,
    json: { body: () => ({ ok: true }) },
    rerender: renderShow,
  });

/** POST /invites/:inviteId/accept */
export const acceptInvite = (req, res) =>
  act(req, res, {
    run: () => groupService.acceptInvite(req.user, req.valid.inviteId),
    redirectTo: ({ groupId }) => `/groups/${groupId}`,
    json: { body: ({ groupId }) => ({ ok: true, groupId }) },
    rerender: renderIndex,
  });

/** POST /invites/:inviteId/decline */
export const declineInvite = (req, res) =>
  act(req, res, {
    run: () => groupService.declineInvite(req.user, req.valid.inviteId),
    redirectTo: () => '/groups',
    json: { body: () => ({ ok: true }) },
    rerender: renderIndex,
  });

/** POST /groups/:id/transfer */
export const transfer = (req, res) =>
  act(req, res, {
    run: () => groupService.transferOwnership(req.user, req.valid.id, req.valid.newOwnerId),
    redirectTo: () => `/groups/${req.valid.id}`,
    json: { body: () => ({ ok: true }) },
    rerender: renderShow,
  });

/** POST /groups/:id/leave */
export const leave = (req, res) =>
  act(req, res, {
    run: () => groupService.leaveGroup(req.user, req.valid.id),
    redirectTo: () => '/groups',
    json: { body: (result) => ({ ok: true, ...result }) },
    rerender: renderShow,
  });
