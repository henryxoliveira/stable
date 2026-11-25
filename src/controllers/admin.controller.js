/**
 * HTTP handlers for the admin accounts page (roadmap A1). Thin: read
 * `req.valid`, call admin.service.js, then redirect (forms) or send JSON.
 *
 * For HTML forms, a 400/404/409 re-renders the page with the message. Admins
 * can see every account, so showing "no account with that email" leaks nothing.
 */
import * as adminService from '../services/admin.service.js';
import { HttpError } from '../utils/httpError.js';
import { wantsJson } from '../utils/request.js';

const FORM_ERROR_STATUSES = [400, 404, 409];

/** Readable text for an audit row on the page. */
const EVENT_LABELS = {
  LANDLORD_APPROVED: 'approved landlord',
  LANDLORD_REJECTED: 'rejected landlord',
  PROMOTED_TO_ADMIN: 'promoted to admin',
};

async function renderAccounts(req, res, { status = 200, errors = {}, values = {} } = {}) {
  const [pending, events] = await Promise.all([
    adminService.listPendingLandlords(),
    adminService.listRecentAccountEvents(),
  ]);
  res
    .status(status)
    .render('admin/accounts', { pending, events, eventLabels: EVENT_LABELS, errors, values });
}

/** `validate()` hook: show field errors on the accounts page. */
export const formInvalid = (req, res, { errors, values }) =>
  renderAccounts(req, res, { status: 400, errors, values });

/** GET /admin/accounts */
export const accounts = (req, res) => renderAccounts(req, res);

/** GET /api/admin/landlords/pending */
export async function apiPending(req, res) {
  res.json({ landlords: await adminService.listPendingLandlords() });
}

/**
 * Run a service call. JSON clients get `{ user }`; browsers are redirected
 * back to the accounts page, or see the page again with the error.
 */
async function act(req, res, run) {
  try {
    const user = await run();
    if (wantsJson(req)) return res.json({ user });
    return res.redirect('/admin/accounts');
  } catch (err) {
    const isFormError = err instanceof HttpError && FORM_ERROR_STATUSES.includes(err.status);
    if (!isFormError || wantsJson(req)) throw err;
    return renderAccounts(req, res, {
      status: err.status,
      errors: { ...(err.details ?? {}), _form: err.message },
      values: req.body ?? {},
    });
  }
}

/** POST /admin/landlords/:id/approve */
export const approve = (req, res) =>
  act(req, res, () => adminService.approveLandlord(req.user, req.valid.id));

/** POST /admin/landlords/:id/reject */
export const reject = (req, res) =>
  act(req, res, () => adminService.rejectLandlord(req.user, req.valid.id, req.valid.reason));

/** POST /admin/promote */
export const promote = (req, res) =>
  act(req, res, () => adminService.promoteToAdmin(req.user, req.valid.email));
