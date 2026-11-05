import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { IntegrationError } from '../errors/app.errors';
import type { Logger } from '../utils/logger.util';

/**
 * PostgreSQL integration (Prisma with the pg driver adapter).
 * This is the only module that constructs the Prisma client.
 */

/**
 * Creates and connects a Prisma client.
 * @param {string} databaseUrl - The PostgreSQL connection string.
 * @param {Logger} logger - Logger for connection events.
 * @returns {Promise<PrismaClient>} A connected client.
 * @throws {IntegrationError} If the database cannot be reached.
 */
export async function connectPrisma(databaseUrl: string, logger: Logger): Promise<PrismaClient> {
  try {
    const adapter = new PrismaPg({ connectionString: databaseUrl });
    const client = new PrismaClient({ adapter });
    await client.$connect();
    logger.info('PostgreSQL connected');
    return client;
  } catch (error) {
    throw new IntegrationError('postgresql', 'Unable to connect to PostgreSQL', error);
  }
}

/**
 * Checks that PostgreSQL answers a trivial query.
 * @param {PrismaClient} client - The Prisma client.
 * @returns {Promise<boolean>} True if healthy.
 */
export async function pingPrisma(client: PrismaClient): Promise<boolean> {
  try {
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
