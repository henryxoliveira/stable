/**
 * HTTP handlers for the cost calculator. Thin: read `req.valid`, call the
 * service, render / redirect (HTML) or send JSON (API).
 */
import * as estimates from '../services/costEstimate.service.js';
import { listMyGroups } from '../services/group.service.js';
import { formatCents } from '../utils/money.js';
import { HttpError, notFound } from '../utils/httpError.js';
import { wantsJson } from '../utils/request.js';

/** The list + create form. Also used to re-render the form after a 400. */
async function renderIndex(req, res, { status = 200, errors = {}, values = {} } = {}) {
  const [list, { groups }] = await Promise.all([
    estimates.listMyEstimates(req.user),
    listMyGroups(req.user),
  ]);
  res
    .status(status)
    .render('costs/index', { estimates: list, groups, errors, values, formatCents });
}

/** `validate()` hook: show field errors on the form instead of an error page. */
export const createInvalid = (req, res, { errors, values }) =>
  renderIndex(req, res, { status: 400, errors, values });

/** GET /costs */
export const index = (req, res) => renderIndex(req, res);

/** GET /api/costs */
export async function apiIndex(req, res) {
  res.json({ estimates: await estimates.listMyEstimates(req.user) });
}

async function loadOwn(req) {
  const estimate = await estimates.getMyEstimate(req.user, req.valid.id);
  if (!estimate) throw notFound();
  return estimate;
}

/** GET /costs/:id */
export async function show(req, res) {
  res.render('costs/show', { estimate: await loadOwn(req), formatCents });
}

/** GET /api/costs/:id */
export async function apiShow(req, res) {
  res.json({ estimate: await loadOwn(req) });
}

/** POST /costs. A 400 from the service (e.g. missing people) re-renders the form. */
export async function create(req, res) {
  try {
    const { id } = await estimates.createEstimate(req.user, req.valid);
    if (wantsJson(req)) return res.status(201).json({ estimate: { id } });
    return res.redirect(`/costs/${id}`);
  } catch (err) {
    const isFormError = err instanceof HttpError && err.status === 400;
    if (!isFormError || wantsJson(req)) throw err;
    return renderIndex(req, res, {
      status: 400,
      errors: { ...(err.details ?? {}), _form: err.message },
      values: req.body ?? {},
    });
  }
}

/** POST /costs/:id/delete */
export async function remove(req, res) {
  if (!(await estimates.deleteEstimate(req.user, req.valid.id))) throw notFound();
  if (wantsJson(req)) return res.json({ ok: true });
  return res.redirect('/costs');
}
