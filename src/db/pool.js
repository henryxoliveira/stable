/**
 * A small node-postgres pool used ONLY by the session store (connect-pg-simple).
 * All application data access goes through Prisma (src/db/prisma.js).
 * SSL is controlled by the connection string (Neon URLs include sslmode=require).
 */
import pg from 'pg';
import { config } from '../config/env.js';

export const sessionPool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 5,
});
