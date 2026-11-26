/**
 * HTTP handlers for group applications. Thin: read `req.valid`, call the service,
 * then render / redirect (HTML forms) or send JSON (/api/... and fetch clients).
 */
import * as applications from '../services/application.service.js';
import { listMyGroups } from '../services/group.service.js';
import { formatCents } from '../utils/money.js';
import { STATE_LABELS } from '../services/application.workflow.js';
import { wantsJson } from '../utils/request.js';

/** Show times on the campus calendar, e.g. "Mar 1, 2027, 5:00 PM Pacific". */
export function formatPacific(date) {
  if (!date) return '';
  const text = new Date(date).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${text} Pacific`;
}

const viewHelpers = { formatPacific, formatCents, STATE_LABELS };

/** GET /units/:id/apply: the unit summary and a "choose your group" form. */
export async function applyPage(req, res) {
  const unit = await applications.getApplyableUnit(req.valid.id);
  const { groups } = await listMyGroups(req.user);
  res.render('applications/apply', { unit, groups, ...viewHelpers });
}

/** POST /units/:id/apply and POST /api/units/:id/applications */
export async function apply(req, res) {
  const app = await applications.apply(req.user, req.valid.id, req.valid.groupId);
  if (wantsJson(req)) return res.status(201).json({ application: app });
  res.redirect(`/applications/${app.id}`);
}

/** GET /applications: my groups' applications. */
export async function index(req, res) {
  const list = await applications.listForStudent(req.user);
  res.render('applications/index', { applications: list, ...viewHelpers });
}

/** GET /api/applications */
export async function apiIndex(req, res) {
  res.json({ applications: await applications.listForStudent(req.user) });
}

/** GET /applications/:id */
export async function show(req, res) {
  const application = await applications.getForViewer(req.user, req.valid.id);
  res.render('applications/show', { application, ...viewHelpers });
}

/** GET /api/applications/:id */
export async function apiShow(req, res) {
  res.json({ application: await applications.getForViewer(req.user, req.valid.id) });
}

/** GET /units/:id/applications: the landlord's incoming applications for one unit. */
export async function unitIndex(req, res) {
  const data = await applications.listForUnit(req.user, req.valid.id);
  res.render('applications/unit', { ...data, ...viewHelpers });
}

/** GET /api/units/:id/applications */
export async function apiUnitIndex(req, res) {
  res.json(await applications.listForUnit(req.user, req.valid.id));
}

/**
 * POST /applications/:id/<move> and POST /api/applications/:id/<move>.
 * Browsers go back to where they act from: students to the application page,
 * landlords to the unit's list of applications.
 */
export function moveHandler(slug) {
  return async (req, res) => {
    const { id, ...input } = req.valid;
    const result = await applications.move(req.user, id, slug, input);
    if (wantsJson(req)) return res.json({ application: result });
    const back =
      req.user.role === 'LANDLORD' ? `/units/${result.unitId}/applications` : `/applications/${id}`;
    res.redirect(back);
  };
}
