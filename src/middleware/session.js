/**
 * Server-side sessions stored in Postgres (the `session` table).
 *
 * Why Postgres and not memory? Cloud Run containers are replaced on every
 * deploy and can scale to several instances. Keeping sessions in the database
 * means users stay logged in across redeploys, every instance sees the same
 * sessions, and logout (req.session.destroy) really deletes the row.
 */
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { config } from '../config/env.js';
import { sessionPool } from '../db/pool.js';

const PgStore = connectPgSimple(session);

export const SESSION_COOKIE_NAME = 'stable.sid';

export const sessionMiddleware = session({
  store: new PgStore({
    pool: sessionPool,
    tableName: 'session',
    createTableIfMissing: false, // the table is created by a Prisma migration
    pruneSessionInterval: config.isTest ? false : 60 * 15, // seconds
  }),
  name: SESSION_COOKIE_NAME,
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false, // don't create rows for visitors who never log in / get a CSRF token
  rolling: true, // each request extends the expiry
  cookie: {
    httpOnly: true, // not readable from JavaScript
    secure: config.isProduction, // HTTPS only in production (Cloud Run terminates TLS)
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  },
});
