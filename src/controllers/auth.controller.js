/**
 * HTTP handlers for register / login / logout. Thin: read `req.valid`,
 * call the service, manage the session, redirect or render.
 */
import * as authService from '../services/auth.service.js';
import { SESSION_COOKIE_NAME } from '../middleware/session.js';
import { config } from '../config/env.js';

export function showLogin(req, res) {
  if (req.user) return res.redirect('/dashboard');
  res.render('auth/login', { errors: {}, values: {} });
}

export function showRegister(req, res) {
  if (req.user) return res.redirect('/dashboard');
  res.render('auth/register', { errors: {}, values: {}, domain: config.studentEmailDomain });
}

/**
 * Regenerate the session id, then store the user id. Regenerating prevents
 * session fixation (an attacker planting a known session id before login).
 */
function startSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

export async function register(req, res) {
  try {
    const user = await authService.registerUser(req.valid);
    await startSession(req, user.id);
    res.redirect('/dashboard');
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') {
      return res.status(409).render('auth/register', {
        errors: { email: err.message },
        values: { email: req.valid.email, role: req.valid.role },
        domain: config.studentEmailDomain,
      });
    }
    throw err;
  }
}

export async function login(req, res) {
  const user = await authService.authenticate(req.valid.email, req.valid.password);
  if (!user) {
    return res.status(401).render('auth/login', {
      errors: { _form: 'Invalid email or password.' },
      values: { email: req.valid.email },
    });
  }
  await startSession(req, user.id);
  res.redirect('/dashboard');
}

/** Delete the session row on the server AND clear the browser cookie. */
export function logout(req, res, next) {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
    });
    res.redirect('/login');
  });
}
