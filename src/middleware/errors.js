/**
 * 404 and central error handling. Registered last in app.js.
 *
 * API/JSON requests always get `{ error: { code, message } }` (plus `details`
 * for validation errors). HTML requests get an error page. Stack traces are
 * logged on the server, never sent to the client in production.
 */
import { config } from '../config/env.js';
import { HttpError, notFound } from '../utils/httpError.js';
import { wantsJson } from '../utils/request.js';

export function notFoundHandler(req, res, next) {
  next(notFound(`No route for ${req.method} ${req.path}`));
}

// Express recognizes error handlers by their 4 arguments, so `next` must stay
// even though it is unused.
export function errorHandler(err, req, res, next) {
  const isKnown = err instanceof HttpError;
  const status = isKnown ? err.status : 500;
  const code = isKnown ? err.code : 'INTERNAL_ERROR';
  const message = isKnown ? err.message : 'Something went wrong.';

  if (!isKnown && !config.isTest) console.error(err);

  if (wantsJson(req)) {
    const body = { error: { code, message } };
    if (isKnown && err.details) body.error.details = err.details;
    if (!isKnown && !config.isProduction) body.error.stack = err.stack;
    return res.status(status).json(body);
  }
  res.status(status).render('errors/error', {
    status,
    message,
    stack: !isKnown && !config.isProduction ? err.stack : null,
  });
}
