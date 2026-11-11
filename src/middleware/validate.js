/**
 * Input validation with zod. Every route that accepts input uses this.
 *
 * On success the parsed (trimmed, coerced) data replaces nothing on req;
 * it is stored at `req.valid` so controllers never touch raw input. Calls can
 * be chained (e.g. params, then body): each one MERGES its fields into `req.valid`.
 *
 * On failure:
 *  - HTML form routes (pass `view`) re-render the form with status 400,
 *    the field errors, and the submitted values (passwords removed).
 *    `view` can also be a function `(req, res, { errors, values })` for pages
 *    that need extra data loaded before they can be rendered.
 *  - Everything else gets `{ error: { code: 'VALIDATION_ERROR', ... } }`.
 */
import { badRequest } from '../utils/httpError.js';
import { wantsJson } from '../utils/request.js';

/**
 * Turn zod issues into `{ fieldName: 'first message' }`.
 * @param {import('zod').ZodError} error
 */
export function fieldErrors(error) {
  const out = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_form';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/**
 * @param {import('zod').ZodTypeAny} schema
 * @param {{ source?: 'body'|'query'|'params', view?: string | Function }} [options]
 */
export function validate(schema, { source = 'body', view } = {}) {
  return (req, res, next) => {
    const result = schema.safeParse(req[source] ?? {});
    if (result.success) {
      req.valid = { ...req.valid, ...result.data };
      return next();
    }
    const errors = fieldErrors(result.error);
    if (view && !wantsJson(req)) {
      // eslint-disable-next-line no-unused-vars
      const { password, ...values } = req.body ?? {};
      if (typeof view === 'function') return view(req, res, { errors, values });
      return res.status(400).render(view, { errors, values });
    }
    next(badRequest('Some fields are missing or invalid.', errors));
  };
}
