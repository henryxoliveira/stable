/**
 * Brute-force protection for login and registration.
 * NOTE: the counter is in memory per Cloud Run instance (see README "Known limitations").
 */
import { rateLimit } from 'express-rate-limit';
import { config } from '../config/env.js';
import { HttpError } from '../utils/httpError.js';

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: config.isTest ? 1000 : 10, // per IP per window
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res, next) =>
    next(new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Please wait a few minutes.')),
});
