/**
 * Authentication middleware: who is the user, and are they allowed in?
 *
 * The session stores ONLY the user's id. On every request `loadUser` re-reads
 * the user from the database, so a suspended account or changed role takes
 * effect immediately instead of waiting for the session to expire.
 */
import { prisma } from '../db/prisma.js';
import { forbidden, unauthorized } from '../utils/httpError.js';
import { wantsJson } from '../utils/request.js';

/** Fields of the user that are safe to attach to req/res.locals (never the hash). */
const PUBLIC_USER_FIELDS = { id: true, email: true, role: true, status: true, createdAt: true };

/**
 * Attach `req.user` (or null) for every request. Runs for public pages too so
 * the layout can show "Log out" when someone is logged in.
 */
export async function loadUser(req, res, next) {
  req.user = null;
  const userId = req.session?.userId;
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: PUBLIC_USER_FIELDS,
    });
    if (user && user.status !== 'SUSPENDED') {
      req.user = user;
    } else {
      // User deleted or suspended since login: drop the stale session.
      await new Promise((resolve) => req.session.destroy(resolve));
    }
  }
  res.locals.currentUser = req.user;
  next();
}

/**
 * Block anonymous requests. Mounted globally in app.js AFTER the public
 * routes, so every route registered later requires login by default.
 * Pages redirect to /login; API/JSON requests get 401.
 */
export function requireLogin(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return next(unauthorized());
  return res.redirect('/login');
}

/**
 * Allow only the listed roles. Use AFTER requireLogin.
 * @example router.get('/admin', requireRole('ADMIN'), handler)
 * @param {...('STUDENT'|'LANDLORD'|'ADMIN')} roles
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

/**
 * Allow only ACTIVE accounts. Landlords start as PENDING and can log in and
 * look around, but anything that publishes (submitting a listing, etc.) must
 * be guarded by this middleware until an admin approves them.
 */
export function requireActiveAccount(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.status !== 'ACTIVE') {
    return next(
      forbidden('Your account is pending approval by a Stable admin.', 'ACCOUNT_PENDING'),
    );
  }
  next();
}
