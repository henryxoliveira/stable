/**
 * An error that maps directly to an HTTP response.
 * Throw these from services/middleware; the central error handler turns them
 * into `{ error: { code, message } }` (API) or an error page (HTML).
 */
export class HttpError extends Error {
  /**
   * @param {number} status  HTTP status code (e.g. 400, 403, 404)
   * @param {string} code    Stable machine-readable code (e.g. 'VALIDATION_ERROR')
   * @param {string} message Human-readable message, safe to show the user
   * @param {object} [details] Optional extra info (e.g. field errors)
   */
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) =>
  new HttpError(400, 'VALIDATION_ERROR', message, details);
export const unauthorized = (message = 'Please log in.') =>
  new HttpError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to do that.', code = 'FORBIDDEN') =>
  new HttpError(403, code, message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message, code = 'CONFLICT') => new HttpError(409, code, message);
