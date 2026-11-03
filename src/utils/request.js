/**
 * True when the client expects JSON (API routes or fetch() calls) rather than HTML.
 * Used to decide between a JSON error body and a rendered page / redirect.
 * @param {import('express').Request} req
 */
export function wantsJson(req) {
  return req.originalUrl.startsWith('/api/') || req.accepts(['html', 'json']) === 'json';
}
