/**
 * Builds the Express app (without listening, so tests can use it directly).
 *
 * ORDER MATTERS. Read top to bottom to see what every request goes through:
 *   security headers → static files → /healthz → body parsing → session →
 *   load user → CSRF → PUBLIC routes → requireLogin → protected routes → errors
 */
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionMiddleware } from './middleware/session.js';
import { loadUser, requireLogin } from './middleware/auth.js';
import { csrfProtection, exposeCsrfToken } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import publicRoutes from './routes/public.routes.js';
import protectedRoutes from './routes/protected.routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  // Cloud Run sits behind Google's HTTPS proxy; trust it so secure cookies
  // and req.ip (used by the rate limiter) work correctly.
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(here, 'views'));
  app.disable('x-powered-by');

  app.use(helmet());

  // --- Public, no session needed ---
  app.use(express.static(path.join(here, 'public'), { maxAge: '1h' }));
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  // --- Parse input (small limits; file uploads will use multer separately) ---
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(express.json({ limit: '100kb' }));

  // --- Session, current user, CSRF ---
  app.use(sessionMiddleware);
  app.use(loadUser);
  app.use(csrfProtection);
  app.use(exposeCsrfToken);

  // --- Public allow-list: login & register only ---
  app.use(publicRoutes);

  // --- Everything below requires login ---
  app.use(requireLogin);
  app.use(protectedRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
