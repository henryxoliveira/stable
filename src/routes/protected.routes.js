/**
 * Everything here runs AFTER requireLogin (see app.js), so every route in
 * this file and the routers it mounts requires an authenticated user.
 */
import { Router } from 'express';
import * as auth from '../controllers/auth.controller.js';
import * as dashboard from '../controllers/dashboard.controller.js';
import * as listings from '../controllers/listings.controller.js';
import { requireActiveAccount, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { z } from 'zod';

const router = Router();

router.get('/', (req, res) => res.redirect('/dashboard'));
router.post('/logout', auth.logout);

// Dashboards (placeholders), one per role.
router.get('/dashboard', dashboard.redirectToRoleDashboard);
router.get('/dashboard/student', requireRole('STUDENT'), dashboard.student);
router.get('/dashboard/landlord', requireRole('LANDLORD'), dashboard.landlord);
router.get('/dashboard/admin', requireRole('ADMIN'), dashboard.admin);

// JSON API
router.get('/api/me', dashboard.me);

// Publishing requires an ACTIVE account: pending landlords are blocked here.
// Students may also own listings (subleases).
router.post(
  '/api/listings/:id/submit',
  requireRole('LANDLORD', 'STUDENT'),
  requireActiveAccount,
  validate(z.object({ id: z.uuid() }), { source: 'params' }),
  listings.submitForApproval,
);

export default router;
