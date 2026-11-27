/**
 * HTTP handlers for in-app notifications. Thin: every call passes `req.user` to
 * the service, which only ever reads or changes that user's own notifications.
 */
import * as notifications from '../services/notification.service.js';
import { wantsJson } from '../utils/request.js';
import { formatPacific } from '../utils/time.js';

/** GET /notifications: newest first. */
export async function index(req, res) {
  const data = await notifications.listMine(req.user);
  res.render('notifications/index', { ...data, formatPacific });
}

/** GET /api/notifications */
export async function apiIndex(req, res) {
  res.json(await notifications.listMine(req.user));
}

/** POST /notifications/:id/read and /api/notifications/:id/read */
export async function markRead(req, res) {
  const notification = await notifications.markRead(req.user, req.valid.id);
  if (wantsJson(req)) return res.json({ notification });
  res.redirect('/notifications');
}

/** POST /notifications/read-all and /api/notifications/read-all */
export async function markAllRead(req, res) {
  const marked = await notifications.markAllRead(req.user);
  if (wantsJson(req)) return res.json({ marked });
  res.redirect('/notifications');
}
