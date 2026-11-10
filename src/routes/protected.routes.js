/**
 * Everything here runs AFTER requireLogin (see app.js), so every route in
 * this file and the routers it mounts requires an authenticated user.
 */
import { Router } from 'express';
import * as auth from '../controllers/auth.controller.js';
import * as dashboard from '../controllers/dashboard.controller.js';
import * as groups from '../controllers/groups.controller.js';
import * as listings from '../controllers/listings.controller.js';
import { requireActiveAccount, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { z } from 'zod';
import {
  createGroupSchema,
  groupIdParams,
  groupInviteParams,
  inviteIdParams,
  inviteSchema,
  transferSchema,
} from '../validation/group.schemas.js';

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

export default router;
