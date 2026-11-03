/**
 * Listings: placeholder only. The real listing workflow
 * (draft → submitted → changes_requested → approved) is a later PR.
 */
import { HttpError } from '../utils/httpError.js';

/**
 * POST /api/listings/:id/submit. The route already enforces
 * LANDLORD/STUDENT + ACTIVE account; ownership and the state machine come next.
 */
export function submitForApproval(req, res, next) {
  // TODO(Member A): load listing via loadOwned(), validate transition, write audit row.
  next(new HttpError(501, 'NOT_IMPLEMENTED', 'Listing submission is not implemented yet.'));
}
