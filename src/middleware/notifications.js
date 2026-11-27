/**
 * The unread count for the header badge. Runs after loadUser, for logged-in
 * users on HTML pages only (JSON clients ask /api/notifications instead).
 */
import { unreadCount } from '../services/notification.service.js';
import { wantsJson } from '../utils/request.js';

export async function loadUnreadCount(req, res, next) {
  res.locals.unreadCount = 0;
  if (req.user && !wantsJson(req)) res.locals.unreadCount = await unreadCount(req.user);
  next();
}
