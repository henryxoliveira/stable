/**
 * CSRF protection (synchronizer-token pattern via csrf-sync).
 *
 * A random token is stored in the server-side session. Every page gets it as
 * `csrfToken` and forms include it as a hidden `_csrf` field; fetch() calls send
 * it in the `x-csrf-token` header. Any POST/PUT/PATCH/DELETE without the right
 * token is rejected with 403. (csurf is deprecated, so we use csrf-sync.)
 */
import { csrfSync } from 'csrf-sync';
import { HttpError } from '../utils/httpError.js';

const { csrfSynchronisedProtection, generateToken } = csrfSync({
  getTokenFromRequest: (req) => req.body?._csrf ?? req.headers['x-csrf-token'],
});

/** Validates the token on unsafe methods; GET/HEAD/OPTIONS pass through. */
export function csrfProtection(req, res, next) {
  csrfSynchronisedProtection(req, res, (err) => {
    if (err) {
      return next(
        new HttpError(
          403,
          'CSRF_INVALID',
          'Invalid or missing form token. Reload the page and try again.',
        ),
      );
    }
    next();
  });
}

/**
 * Expose `csrfToken()` to every template. It is a function (called as
 * `<%= csrfToken() %>`) so a token, and therefore a session row, is only
 * created for pages that actually contain a form.
 */
export function exposeCsrfToken(req, res, next) {
  res.locals.csrfToken = () => generateToken(req);
  next();
}
