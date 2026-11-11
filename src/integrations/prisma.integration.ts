import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { IntegrationError } from '../errors/app.errors';
import type { Logger } from '../utils/logger.util';

/**
 * PostgreSQL integration (Prisma with the pg driver adapter).
 * This is the only module that constructs the Prisma client.
 */

/** PostgreSQL connection settings (the `database` section of the app config). */
export interface PostgresConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  name: string;
  /** Enables TLS verified against the provider's CA certificate (e.g. Aiven). */
  ssl: boolean;
  /** PEM CA certificate — inline PEM or a path to a .pem file. Required when ssl is true. */
  caCert?: string;
}

/**
 * Resolves the CA certificate: inline PEM values pass straight through,
 * anything else is treated as a path to a .pem file and read from disk.
 * @param {string | undefined} caCert - Inline PEM or a file path.
 * @returns {string | undefined} The PEM certificate, or undefined when none was supplied.
 */
const resolveCaCertificate = (caCert?: string): string | undefined => {
  if (!caCert) return undefined;
  return caCert.includes('BEGIN CERTIFICATE') ? caCert : readFileSync(caCert, 'utf-8');
};

/**
 * Creates and connects a Prisma client.
 * @param {PostgresConfig} settings - The PostgreSQL connection settings.
 * @param {Logger} logger - Logger for connection events.
 * @returns {Promise<PrismaClient>} A connected client.
 * @throws {IntegrationError} If the database cannot be reached.
 */
export async function connectPrisma(settings: PostgresConfig, logger: Logger): Promise<PrismaClient> {
  try {
    const adapter = new PrismaPg({
      host: settings.host,
      port: settings.port,
      user: settings.user,
      password: settings.password,
      database: settings.name,
      // Aiven-style TLS: verify the server against the provider's CA. Local
      // instances and providers without a custom CA keep DATABASE_SSL off.
      ssl: settings.ssl
        ? { rejectUnauthorized: true, ca: resolveCaCertificate(settings.caCert) }
        : undefined,
    });
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
