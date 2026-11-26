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

/** AI lease summaries allowed per student per hour (each one costs money). */
export const LEASE_SUMMARIES_PER_HOUR = 5;

/**
 * Rate limit for AI lease summaries: 5 per student per hour, counted by USER id
 * (not IP), so students sharing campus Wi-Fi don't use up each other's limit.
 * Mounted after the upload checks, so only uploads that would reach the AI count
 * (including ones whose AI reply is later rejected, so retries can't skip it).
 * createApp() makes one per app; read it through `leaseSummaryLimit` below.
 * NOTE: the counter is in memory per Cloud Run instance (README "Known limitations").
 */
export function createLeaseSummaryLimiter() {
  return rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    limit: LEASE_SUMMARIES_PER_HOUR,
    keyGenerator: (req) => `user:${req.user.id}`,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res, next) =>
      next(
        new HttpError(
          429,
          'RATE_LIMITED',
          `You can summarize up to ${LEASE_SUMMARIES_PER_HOUR} leases per hour. Please try again later.`,
        ),
      ),
  });
}

/** Route middleware that uses this app's own limiter (see createApp). */
export function leaseSummaryLimit(req, res, next) {
  return req.app.locals.leaseSummaryLimiter(req, res, next);
}
