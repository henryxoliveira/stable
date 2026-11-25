/**
 * Everything here runs AFTER requireLogin (see app.js), so every route in
 * this file and the routers it mounts requires an authenticated user.
 */
import { Router } from 'express';
import * as auth from '../controllers/auth.controller.js';
import * as costs from '../controllers/costs.controller.js';
import * as dashboard from '../controllers/dashboard.controller.js';
import * as groups from '../controllers/groups.controller.js';
import * as props from '../controllers/properties.controller.js';
import * as listings from '../controllers/listings.controller.js';
import { requireActiveAccount, requireRole } from '../middleware/auth.js';
import {
  floorPlanSchema,
  idParams,
  propertySchema,
  unitSchema,
} from '../validation/property.schemas.js';
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
import { createEstimateSchema, estimateIdParams } from '../validation/cost.schemas.js';

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

// Properties, units, floor plans (A2). Landlords (pending ones too) create and
// edit their OWN; admins may view all but not edit (403); students get 403.
// Ownership (404 for other landlords) is checked in services/property.service.js.
// `/properties/new` is registered before `/properties/:id` so "new" isn't read as an id.
const landlord = requireRole('LANDLORD');
const landlordOrAdmin = requireRole('LANDLORD', 'ADMIN');
const id = validate(idParams, { source: 'params' });

router.get('/properties', landlordOrAdmin, props.index);
router.get('/api/properties', landlordOrAdmin, props.apiIndex);
router.get('/properties/new', landlord, props.newProperty);
router.post(
  '/properties',
  landlord,
  validate(propertySchema, { view: props.propertyInvalid }),
  props.createProperty,
);
router.get('/properties/:id', landlordOrAdmin, id, props.show);
router.get('/api/properties/:id', landlordOrAdmin, id, props.apiShow);
router.get('/properties/:id/edit', landlord, id, props.editProperty);
router.post(
  '/properties/:id',
  landlord,
  id,
  validate(propertySchema, { view: props.propertyInvalid }),
  props.updateProperty,
);

router.get('/properties/:id/units/new', landlord, id, props.newUnit);
router.post(
  '/properties/:id/units',
  landlord,
  id,
  validate(unitSchema, { view: props.newUnitInvalid }),
  props.createUnit,
);
router.get('/units/:id/edit', landlord, id, props.editUnit);
router.post(
  '/units/:id',
  landlord,
  id,
  validate(unitSchema, { view: props.editUnitInvalid }),
  props.updateUnit,
);

router.get('/units/:id/floor-plans/new', landlord, id, props.newFloorPlan);
router.post(
  '/units/:id/floor-plans',
  landlord,
  id,
  validate(floorPlanSchema, { view: props.newFloorPlanInvalid }),
  props.createFloorPlan,
);
router.get('/floor-plans/:id/edit', landlord, id, props.editFloorPlan);
router.post(
  '/floor-plans/:id',
  landlord,
  id,
  validate(floorPlanSchema, { view: props.editFloorPlanInvalid }),
  props.updateFloorPlan,
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
