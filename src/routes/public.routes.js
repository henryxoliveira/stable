/**
 * PUBLIC ROUTES: the complete allow-list of pages reachable without login.
 * Adding a route here is a security decision; it needs a reviewer's sign-off.
 * (Static assets and /healthz are mounted directly in app.js.)
 */
import { Router } from 'express';
import * as auth from '../controllers/auth.controller.js';
import { validate } from '../middleware/validate.js';
import { authRateLimit } from '../middleware/rateLimit.js';
import { loginSchema, registerSchema } from '../validation/auth.schemas.js';

const router = Router();

router.get('/login', auth.showLogin);
router.post('/login', authRateLimit, validate(loginSchema, { view: 'auth/login' }), auth.login);

router.get('/register', auth.showRegister);
router.post(
  '/register',
  authRateLimit,
  validate(registerSchema, { view: 'auth/register' }),
  auth.register,
);

export default router;
