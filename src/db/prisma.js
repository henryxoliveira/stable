/**
 * Single shared Prisma client for the whole process.
 * Uses config.DATABASE_URL so tests automatically hit DATABASE_URL_TEST.
 */
import { PrismaClient } from '@prisma/client';
import { config } from '../config/env.js';

export const prisma = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
