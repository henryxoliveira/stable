/**
 * HTTP handlers for properties, units, and floor plans (roadmap A2). Thin:
 * read `req.valid`, call property.service.js, then redirect (forms) or send JSON.
 *
 * Each form has one render function, used for the first page load, for zod
 * errors (the `validate()` hook, 400), and for service errors like a duplicate
 * label (409). 403/404 go to the central error handler, so nothing leaks.
 */
import * as properties from '../services/property.service.js';
import { HttpError } from '../utils/httpError.js';
import { centsToInput, formatCents } from '../utils/money.js';
import { wantsJson } from '../utils/request.js';

/** A saved record → form field values (null → '', cents → dollars). */
const toValues = (record) =>
  Object.fromEntries(
    Object.entries(record ?? {}).map(([key, value]) => {
      if (key.endsWith('Cents') && typeof value === 'number') {
        return [key.replace(/Cents$/, ''), centsToInput(value)];
      }
      return [key, value ?? ''];
    }),
  );

/**
 * Run a write. JSON clients get `{ [key]: result }` (201 for creates);
 * browsers are redirected. A 400/409 re-renders the form for browsers.
 */
async function save(req, res, { run, key, created = false, redirectTo, rerender }) {
  try {
    const result = await run();
    if (wantsJson(req)) return res.status(created ? 201 : 200).json({ [key]: result });
    return res.redirect(redirectTo(result));
  } catch (err) {
    const isFormError = err instanceof HttpError && (err.status === 400 || err.status === 409);
    if (!isFormError || wantsJson(req)) throw err;
    const errors = { ...(err.details ?? {}), _form: err.message };
    return rerender(req, res, { status: err.status, errors, values: req.body ?? {} });
  }
}

// --- properties --------------------------------------------------------------

/** GET /properties */
export async function index(req, res) {
  res.render('properties/index', { properties: await properties.listProperties(req.user) });
}

/** GET /api/properties */
export async function apiIndex(req, res) {
  res.json({ properties: await properties.listProperties(req.user) });
}

/** GET /properties/:id */
export async function show(req, res) {
  const property = await properties.getProperty(req.user, req.valid.id);
  res.render('properties/show', { property, formatCents });
}

/** GET /api/properties/:id */
export async function apiShow(req, res) {
  res.json({ property: await properties.getProperty(req.user, req.valid.id) });
}

/** The new/edit property form. `req.valid.id` is set when editing. */
async function renderPropertyForm(req, res, { status = 200, errors = {}, values } = {}) {
  const property = req.valid?.id
    ? await properties.getPropertyForEdit(req.user, req.valid.id)
    : null;
  res.status(status).render('properties/form', {
    property,
    errors,
    values: values ?? (property ? toValues(property) : { state: 'CA' }),
  });
}

export const newProperty = (req, res) => renderPropertyForm(req, res);
export const editProperty = (req, res) => renderPropertyForm(req, res);
export const propertyInvalid = (req, res, { errors, values }) =>
  renderPropertyForm(req, res, { status: 400, errors, values });

/** POST /properties */
export const createProperty = (req, res) =>
  save(req, res, {
    run: () => properties.createProperty(req.user, req.valid),
    key: 'property',
    created: true,
    redirectTo: (p) => `/properties/${p.id}`,
    rerender: renderPropertyForm,
  });

/** POST /properties/:id */
export const updateProperty = (req, res) => {
  const { id, ...input } = req.valid;
  return save(req, res, {
    run: () => properties.updateProperty(req.user, id, input),
    key: 'property',
    redirectTo: (p) => `/properties/${p.id}`,
    rerender: renderPropertyForm,
  });
};

// --- units ---------------------------------------------------------------------

/**
 * The unit form. New: `req.valid.id` is the PROPERTY id (/properties/:id/units/new).
 * Edit: it is the UNIT id (/units/:id/edit). `editing` tells them apart.
 */
function unitForm(editing) {
  return async (req, res, { status = 200, errors = {}, values } = {}) => {
    const unit = editing ? await properties.getUnitForEdit(req.user, req.valid.id) : null;
    const property = unit
      ? unit.property
      : await properties.getPropertyForEdit(req.user, req.valid.id);
    res.status(status).render('units/form', {
      property,
      unit,
      errors,
      values: values ?? (unit ? toValues(unit) : { utilities: '0', parking: '0' }),
    });
  };
}

const renderNewUnit = unitForm(false);
const renderEditUnit = unitForm(true);
export const newUnit = (req, res) => renderNewUnit(req, res);
export const editUnit = (req, res) => renderEditUnit(req, res);
export const newUnitInvalid = (req, res, { errors, values }) =>
  renderNewUnit(req, res, { status: 400, errors, values });
export const editUnitInvalid = (req, res, { errors, values }) =>
  renderEditUnit(req, res, { status: 400, errors, values });

/** POST /properties/:id/units */
export const createUnit = (req, res) => {
  const { id: propertyId, ...input } = req.valid;
  return save(req, res, {
    run: () => properties.createUnit(req.user, propertyId, input),
    key: 'unit',
    created: true,
    redirectTo: () => `/properties/${propertyId}`,
    rerender: renderNewUnit,
  });
};

/** POST /units/:id */
export const updateUnit = (req, res) => {
  const { id, ...input } = req.valid;
  return save(req, res, {
    run: () => properties.updateUnit(req.user, id, input),
    key: 'unit',
    redirectTo: (unit) => `/properties/${unit.propertyId}`,
    rerender: renderEditUnit,
  });
};

// --- floor plans -----------------------------------------------------------------

/** The floor plan form. New: `req.valid.id` is the UNIT id. Edit: the FLOOR PLAN id. */
function floorPlanForm(editing) {
  return async (req, res, { status = 200, errors = {}, values } = {}) => {
    const plan = editing ? await properties.getFloorPlanForEdit(req.user, req.valid.id) : null;
    const unit = plan ? plan.unit : await properties.getUnitForEdit(req.user, req.valid.id);
    res.status(status).render('floor-plans/form', {
      unit,
      plan,
      errors,
      values: values ?? toValues(plan),
    });
  };
}

const renderNewFloorPlan = floorPlanForm(false);
const renderEditFloorPlan = floorPlanForm(true);
export const newFloorPlan = (req, res) => renderNewFloorPlan(req, res);
export const editFloorPlan = (req, res) => renderEditFloorPlan(req, res);
export const newFloorPlanInvalid = (req, res, { errors, values }) =>
  renderNewFloorPlan(req, res, { status: 400, errors, values });
export const editFloorPlanInvalid = (req, res, { errors, values }) =>
  renderEditFloorPlan(req, res, { status: 400, errors, values });

/** POST /units/:id/floor-plans */
export const createFloorPlan = (req, res) => {
  const { id: unitId, ...input } = req.valid;
  return save(req, res, {
    run: () => properties.createFloorPlan(req.user, unitId, input),
    key: 'floorPlan',
    created: true,
    redirectTo: (plan) => `/properties/${plan.unit.propertyId}`,
    rerender: renderNewFloorPlan,
  });
};

/** POST /floor-plans/:id */
export const updateFloorPlan = (req, res) => {
  const { id, ...input } = req.valid;
  return save(req, res, {
    run: () => properties.updateFloorPlan(req.user, id, input),
    key: 'floorPlan',
    redirectTo: (plan) => `/properties/${plan.unit.propertyId}`,
    rerender: renderEditFloorPlan,
  });
};
