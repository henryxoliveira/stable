/**
 * Record-level authorization ("can THIS user touch THIS record?").
 *
 * Role checks (requireRole) answer "can a landlord call this route at all?".
 * The helpers here answer "is this the landlord who OWNS listing 42?".
 * Every service that reads or changes a record must go through one of them.
 *
 * Policy: when a user may not see a record we respond 404, not 403, so we
 * never reveal that the record exists. The data itself is never returned.
 */
import { notFound } from '../utils/httpError.js';

/**
 * True if `user` owns `record` (record[ownerField] === user.id) or is an admin.
 * @param {{ id: string, role: string }} user
 * @param {object|null} record
 * @param {string} [ownerField='ownerId']
 */
export function canAccessOwned(user, record, ownerField = 'ownerId') {
  if (!user || !record) return false;
  if (user.role === 'ADMIN') return true;
  return record[ownerField] === user.id;
}

/**
 * Throw 404 unless the user owns the record (or is an admin). Returns the
 * record so it can be used inline:
 *   const listing = assertOwnership(req.user, await findListing(id));
 * @template T
 * @param {{ id: string, role: string }} user
 * @param {T|null} record
 * @param {string} [ownerField='ownerId']
 * @returns {T}
 */
export function assertOwnership(user, record, ownerField = 'ownerId') {
  if (!canAccessOwned(user, record, ownerField)) throw notFound();
  return record;
}

/**
 * Route-level version of assertOwnership. `loader(req)` fetches the record;
 * on success it is stored on `req.record` for the controller.
 *
 * @example
 *   router.patch('/listings/:id',
 *     loadOwned((req) => prisma.listing.findUnique({ where: { id: req.params.id } })),
 *     controller.update)
 *
 * @param {(req: import('express').Request) => Promise<object|null>} loader
 * @param {{ ownerField?: string }} [options]
 */
export function loadOwned(loader, { ownerField = 'ownerId' } = {}) {
  return async (req, res, next) => {
    const record = await loader(req);
    req.record = assertOwnership(req.user, record, ownerField);
    next();
  };
}
