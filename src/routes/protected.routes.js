/**
 * Everything here runs AFTER requireLogin (see app.js), so every route in
 * this file and the routers it mounts requires an authenticated user.
 */
import { Router } from 'express';
import * as auth from '../controllers/auth.controller.js';
import * as costs from '../controllers/costs.controller.js';
import * as dashboard from '../controllers/dashboard.controller.js';
import * as groups from '../controllers/groups.controller.js';
import * as listings from '../controllers/listings.controller.js';
import * as admin from '../controllers/admin.controller.js';
import { requireActiveAccount, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { z } from 'zod';
import { promoteSchema, rejectSchema, userIdParams } from '../validation/admin.schemas.js';
import {
  createGroupSchema,
  groupIdParams,
  groupInviteParams,
  inviteIdParams,
  inviteSchema,
  transferSchema,
} from '../validation/group.schemas.js';
import { createEstimateSchema, estimateIdParams } from '../validation/cost.schemas.js';

const router = Router();

router.get('/', (req, res) => res.redirect('/dashboard'));
router.post('/logout', auth.logout);

// Dashboards (placeholders), one per role.
router.get('/dashboard', dashboard.redirectToRoleDashboard);
router.get('/dashboard/student', requireRole('STUDENT'), dashboard.student);
router.get('/dashboard/landlord', requireRole('LANDLORD'), dashboard.landlord);
router.get('/dashboard/admin', requireRole('ADMIN'), dashboard.admin);

// Admin accounts (A1): approve or reject pending landlords, promote to admin.
// Admins only; everyone else gets 403 from requireRole.
const adminOnly = requireRole('ADMIN');
const userId = validate(userIdParams, { source: 'params' });

router.get('/admin/accounts', adminOnly, admin.accounts);
router.get('/api/admin/landlords/pending', adminOnly, admin.apiPending);
router.post('/admin/landlords/:id/approve', adminOnly, userId, admin.approve);
router.post(
  '/admin/landlords/:id/reject',
  adminOnly,
  userId,
  validate(rejectSchema, { view: admin.formInvalid }),
  admin.reject,
);
router.post(
  '/admin/promote',
  adminOnly,
  validate(promoteSchema, { view: admin.formInvalid }),
  admin.promote,
);

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

// Roommate groups (B1). Only students use these routes; admins may VIEW any group.
// Landlords get 403 from requireRole. Membership checks (404 for strangers,
// 403 for non-owners) happen in services/group.service.js.
const student = requireRole('STUDENT');
const studentOrAdmin = requireRole('STUDENT', 'ADMIN');
const groupId = validate(groupIdParams, { source: 'params' });

router.get('/groups', student, groups.index);
router.get('/api/groups', student, groups.apiIndex);
router.post(
  '/groups',
  student,
  validate(createGroupSchema, { view: groups.createInvalid }),
  groups.create,
);
router.get('/groups/:id', studentOrAdmin, groupId, groups.show);
router.get('/api/groups/:id', studentOrAdmin, groupId, groups.apiShow);
router.post(
  '/groups/:id/invites',
  student,
  groupId,
  validate(inviteSchema, { view: groups.groupFormInvalid }),
  groups.invite,
);
router.post(
  '/groups/:id/invites/:inviteId/cancel',
  student,
  validate(groupInviteParams, { source: 'params' }),
  groups.cancelInvite,
);
router.post(
  '/groups/:id/transfer',
  student,
  groupId,
  validate(transferSchema, { view: groups.groupFormInvalid }),
  groups.transfer,
);
router.post('/groups/:id/leave', student, groupId, groups.leave);
router.post(
  '/invites/:inviteId/accept',
  student,
  validate(inviteIdParams, { source: 'params' }),
  groups.acceptInvite,
);
router.post(
  '/invites/:inviteId/decline',
  student,
  validate(inviteIdParams, { source: 'params' }),
  groups.declineInvite,
);

// Cost calculator (B2). Students only (landlords and admins get 403). Each
// student only ever sees their own estimates: the service filters by user id,
// so anyone else's estimate is a 404.
const estimateId = validate(estimateIdParams, { source: 'params' });

router.get('/costs', student, costs.index);
router.get('/api/costs', student, costs.apiIndex);
router.post(
  '/costs',
  student,
  validate(createEstimateSchema, { view: costs.createInvalid }),
  costs.create,
);
router.get('/costs/:id', student, estimateId, costs.show);
router.get('/api/costs/:id', student, estimateId, costs.apiShow);
router.post('/costs/:id/delete', student, estimateId, costs.remove);

export default router;
