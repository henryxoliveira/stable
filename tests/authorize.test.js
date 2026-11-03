/**
 * Unit tests for the record-ownership helpers (no database needed).
 */
import { describe, expect, it } from 'vitest';
import { assertOwnership, canAccessOwned, loadOwned } from '../src/middleware/authorize.js';
import { HttpError } from '../src/utils/httpError.js';

const owner = { id: 'u1', role: 'LANDLORD' };
const otherLandlord = { id: 'u2', role: 'LANDLORD' };
const admin = { id: 'u3', role: 'ADMIN' };
const listing = { id: 'l1', ownerId: 'u1' };

describe('ownership checks', () => {
  it('lets the owner and admins in, and nobody else', () => {
    expect(canAccessOwned(owner, listing)).toBe(true);
    expect(canAccessOwned(admin, listing)).toBe(true);
    expect(canAccessOwned(otherLandlord, listing)).toBe(false);
    expect(canAccessOwned(null, listing)).toBe(false);
    expect(canAccessOwned(owner, null)).toBe(false);
  });

  it('supports a custom owner field', () => {
    expect(canAccessOwned(owner, { landlordId: 'u1' }, 'landlordId')).toBe(true);
  });

  it('assertOwnership throws 404 (not 403) so existence is not revealed', () => {
    expect(assertOwnership(owner, listing)).toBe(listing);
    try {
      assertOwnership(otherLandlord, listing);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(404);
    }
  });

  it('loadOwned puts the record on req, or fails with 404', async () => {
    const mw = loadOwned(async () => listing);
    const ok = { user: owner };
    await mw(ok, {}, () => {});
    expect(ok.record).toBe(listing);

    await expect(mw({ user: otherLandlord }, {}, () => {})).rejects.toMatchObject({ status: 404 });
  });
});
