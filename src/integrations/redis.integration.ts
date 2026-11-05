import IORedis, { type Redis } from 'ioredis';
import { IntegrationError } from '../errors/app.errors';
import type { Logger } from '../utils/logger.util';

/**
 * Redis integration (ioredis). Used for rate limiting and, through BullMQ, for job queues.
 * BullMQ requires `maxRetriesPerRequest: null` on blocking connections.
 */

/**
 * Creates a Redis client and waits until it is ready.
 * @param {string} url - The Redis connection URL.
 * @param {Logger} logger - Logger for connection events.
 * @returns {Promise<Redis>} A ready client.
 * @throws {IntegrationError} If Redis cannot be reached.
 */
export async function connectRedis(url: string, logger: Logger): Promise<Redis> {
  const client = new IORedis(url, { maxRetriesPerRequest: null, lazyConnect: true });
  client.on('error', (error) => logger.error('Redis error', { error }));
  try {
    await client.connect();
    logger.info('Redis connected');
    return client;
  } catch (error) {
    client.disconnect();
    throw new IntegrationError('redis', 'Unable to connect to Redis', error);
  }
}

/**
 * Checks that Redis answers PING.
 * @param {Redis} client - The Redis client.
 * @returns {Promise<boolean>} True if healthy.
 */
export async function pingRedis(client: Redis): Promise<boolean> {
  try {
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  }
}
