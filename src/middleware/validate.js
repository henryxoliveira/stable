/**
 * Input validation with zod. Every route that accepts input uses this.
 *
 * On success the parsed (trimmed, coerced) data replaces nothing on req;
 * it is stored at `req.valid` so controllers never touch raw input. Calls can
 * be chained (e.g. params, then body): each one MERGES its fields into `req.valid`.
 * A later validator may never overwrite an earlier validated value: if two
 * schemas declare the same key with DIFFERENT values (e.g. params.id vs. body.id),
 * the request is rejected with 400. Unknown keys are dropped by zod, so a body
 * can only collide with a param when its schema declares that key.
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
 * Keys that an earlier validator already set to a different value.
 * @param {object|undefined} earlier  current req.valid
 * @param {object} later              this validator's parsed data
 * @returns {object|null} `{ key: message }`, or null when there is no conflict
 */
export function conflictingKeys(earlier = {}, later = {}) {
  const out = {};
  for (const [key, value] of Object.entries(later)) {
    // Object.hasOwn, not `in`: `in` also matches inherited names ('toString' in {} is true),
    // which would turn a body field named "toString" into a false conflict.
    if (Object.hasOwn(earlier, key) && JSON.stringify(earlier[key]) !== JSON.stringify(value)) {
      out[key] = `Conflicting values for "${key}" in the request.`;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * @param {import('zod').ZodTypeAny} schema
 * @param {{ source?: 'body'|'query'|'params', view?: string | Function }} [options]
 */
export function validate(schema, { source = 'body', view } = {}) {
  return (req, res, next) => {
    const result = schema.safeParse(req[source] ?? {});
    let errors;
    if (result.success) {
      errors = conflictingKeys(req.valid, result.data);
      if (!errors) {
        req.valid = { ...req.valid, ...result.data };
        return next();
      }
    } else {
      errors = fieldErrors(result.error);
    }
    if (view && !wantsJson(req)) {
      // eslint-disable-next-line no-unused-vars
      const { password, ...values } = req.body ?? {};
      if (typeof view === 'function') return view(req, res, { errors, values });
      return res.status(400).render(view, { errors, values });
    }
    next(badRequest('Some fields are missing or invalid.', errors));
  };
}
