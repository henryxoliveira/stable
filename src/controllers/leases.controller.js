/**
 * HTTP handlers for AI lease summaries. Thin: the upload is already checked by
 * middleware (AI on, a real PDF ≤ 5 MB, under the rate limit); the service talks
 * to Claude, checks the reply, and saves only the checked summary.
 */
import * as summaries from '../services/leaseSummary.service.js';
import { formatCents } from '../services/cost.service.js';
import { HttpError, notFound } from '../utils/httpError.js';
import { wantsJson } from '../utils/request.js';

/** Friendly labels for the subletting answer. */
const SUBLETTING_LABELS = {
  yes: 'Allowed',
  no: 'Not allowed',
  with_permission: 'Allowed with the landlord’s permission',
  not_stated: 'Not stated in the lease',
};

const aiEnabled = (req) => Boolean(req.app.locals.aiClient);

/** Block AI routes when no API key is configured (checked before reading the upload). */
export function requireAiEnabled(req, res, next) {
  if (aiEnabled(req)) return next();
  next(
    new HttpError(
      503,
      'AI_DISABLED',
      'AI lease summaries are turned off on this site. You can still enter costs yourself.',
    ),
  );
}

/** GET /leases: my summaries + the upload form (or a note that AI is off). */
export async function index(req, res) {
  res.render('leases/index', {
    summaries: await summaries.listMySummaries(req.user),
    aiEnabled: aiEnabled(req),
  });
}

/** POST /leases (fetch from /js/lease-upload.js, CSRF token in the header). */
export async function create(req, res) {
  const { id } = await summaries.summarizeAndSave(req.user, req.app.locals.aiClient, req.file);
  // Always JSON-friendly: the upload script follows `location`.
  res.status(201).json({ summary: { id }, location: `/leases/${id}` });
}

async function loadOwn(req) {
  const summary = await summaries.getMySummary(req.user, req.valid.id);
  if (!summary) throw notFound();
  return summary;
}

/** GET /leases/:id */
export async function show(req, res) {
  res.render('leases/show', {
    summary: await loadOwn(req),
    formatCents,
    subletLabel: SUBLETTING_LABELS,
  });
}

/** GET /api/leases/:id */
export async function apiShow(req, res) {
  res.json({ summary: await loadOwn(req) });
}

/** POST /leases/:id/delete */
export async function remove(req, res) {
  if (!(await summaries.deleteMySummary(req.user, req.valid.id))) throw notFound();
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect('/leases');
}
