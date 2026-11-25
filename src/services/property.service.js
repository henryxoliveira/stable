/**
 * Properties, units, and floor plans (roadmap A2): database access + authorization.
 *
 * Who can do what:
 *   - A landlord sees and edits only their OWN properties, and the units and
 *     floor plans inside them. Anyone else's record is a 404, so its existence
 *     isn't revealed. Pending landlords can set up properties too; they just
 *     can't publish listings until an admin approves them.
 *   - An admin can see every property (oversight) but not edit (routes are
 *     LANDLORD-only for writes, so admins get 403 there).
 *   - Students never reach these routes (403 from requireRole).
 *
 * Writes (and the edit pages) go through `assertCanEdit`, which is stricter:
 * only the owner, so an admin gets 403 even if a route forgot the role check.
 *
 * Ownership lives on the property (`owner_id`). Units and floor plans are
 * checked through their property, in the same query that loads them.
 */
import { prisma } from '../db/prisma.js';
import { assertOwnership } from '../middleware/authorize.js';
import { conflict, forbidden } from '../utils/httpError.js';

/**
 * Throw unless `user` may change `property`: 404 if they can't even see it,
 * 403 if they can see it but aren't the owner (an admin). Returns the property.
 */
function assertCanEdit(user, property) {
  assertOwnership(user, property);
  if (property.ownerId !== user.id) throw forbidden('Only the owner can change this.');
  return property;
}

const UNIT_ORDER = { label: 'asc' };
const FLOOR_PLAN_ORDER = { name: 'asc' };
/** Returned with a saved floor plan, so the caller knows which property page to go back to. */
const PLAN_UNIT = { unit: { select: { propertyId: true } } };

/** Turn a unique-constraint error (P2002) into a friendly 409. */
async function uniqueOr409(promise, message, code) {
  try {
    return await promise;
  } catch (err) {
    if (err.code === 'P2002') throw conflict(message, code);
    throw err;
  }
}

// --- properties --------------------------------------------------------------

/**
 * Properties the user may see: their own (landlord) or all (admin).
 * The filter is in the query, so other landlords' rows are never loaded.
 */
export function listProperties(user) {
  return prisma.property.findMany({
    where: user.role === 'ADMIN' ? {} : { ownerId: user.id },
    orderBy: { createdAt: 'desc' },
    include: {
      owner: { select: { email: true } },
      _count: { select: { units: true } },
    },
  });
}

/** One property with its units and floor plans. 404 unless owner or admin. */
export async function getProperty(user, id) {
  const property = await prisma.property.findUnique({
    where: { id },
    include: {
      owner: { select: { email: true } },
      units: { orderBy: UNIT_ORDER, include: { floorPlans: { orderBy: FLOOR_PLAN_ORDER } } },
    },
  });
  return assertOwnership(user, property);
}

/** The property row only, for its edit page and writes. Owner only. */
export async function getPropertyForEdit(user, id) {
  return assertCanEdit(user, await prisma.property.findUnique({ where: { id } }));
}

export function createProperty(user, input) {
  return prisma.property.create({ data: { ...input, ownerId: user.id } });
}

export async function updateProperty(user, id, input) {
  await getPropertyForEdit(user, id);
  return prisma.property.update({ where: { id }, data: input });
}

// --- units ---------------------------------------------------------------------

/** A unit with its property, for its edit page and writes. Owner only (checked on the property). */
export async function getUnitForEdit(user, id) {
  const unit = await prisma.unit.findUnique({ where: { id }, include: { property: true } });
  assertCanEdit(user, unit?.property);
  return unit;
}

export async function createUnit(user, propertyId, input) {
  await getPropertyForEdit(user, propertyId);
  return uniqueOr409(
    prisma.unit.create({ data: { ...input, propertyId } }),
    'This property already has a unit with that label.',
    'UNIT_LABEL_TAKEN',
  );
}

export async function updateUnit(user, id, input) {
  await getUnitForEdit(user, id);
  return uniqueOr409(
    prisma.unit.update({ where: { id }, data: input }),
    'This property already has a unit with that label.',
    'UNIT_LABEL_TAKEN',
  );
}

// --- floor plans -----------------------------------------------------------------

/** A floor plan with its unit and property, for its edit page and writes. Owner only. */
export async function getFloorPlanForEdit(user, id) {
  const plan = await prisma.floorPlan.findUnique({
    where: { id },
    include: { unit: { include: { property: true } } },
  });
  assertCanEdit(user, plan?.unit.property);
  return plan;
}

export async function createFloorPlan(user, unitId, input) {
  await getUnitForEdit(user, unitId);
  return uniqueOr409(
    prisma.floorPlan.create({ data: { ...input, unitId }, include: PLAN_UNIT }),
    'This unit already has a floor plan with that name.',
    'FLOOR_PLAN_NAME_TAKEN',
  );
}

export async function updateFloorPlan(user, id, input) {
  await getFloorPlanForEdit(user, id);
  return uniqueOr409(
    prisma.floorPlan.update({ where: { id }, data: input, include: PLAN_UNIT }),
    'This unit already has a floor plan with that name.',
    'FLOOR_PLAN_NAME_TAKEN',
  );
}
