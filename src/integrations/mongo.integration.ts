import mongoose from 'mongoose';
import dns from 'node:dns';
import { IntegrationError } from '../errors/app.errors';
import type { Logger } from '../utils/logger.util';

/**
 * MongoDB integration (Mongoose). This is the only module that opens the Mongo connection.
 * MongoDB holds non-financial, high-churn data: verification codes, audit logs and command-centre state.
 */

/**
 * DNS server presets for MongoDB SRV resolution.
 * Variables for easy switching when the built-in Node.js DNS resolver
 * fails to resolve MongoDB Atlas SRV records (querySrv ECONNREFUSED).
 * This is a known issue: https://github.com/nodejs/node/issues/61448
 */
// const CLOUDFLARE_DNS = [
//   '1.1.1.1', // Cloudflare Primary
//   '1.0.0.1', // Cloudflare Secondary
// ];

// const GOOGLE_DNS = [
//   '8.8.8.8', // Google Primary
//   '8.8.4.4', // Google Secondary
// ];

const ALIDNS_DNS = [
  '223.5.5.70',
  '223.6.6.199',
  '119.29.29.29',
  '180.76.76.76',
  '114.114.114.114',
  '114.114.115.115',
];

/**
 * Fix for MongoDB SRV DNS resolution failures on Node.js 24+.
 * Set explicit DNS servers to restore reliable resolution.
 * Active preset: ALIDNS. Switch the spread array below
 * to change providers (e.g., [...ALIDNS_DNS] for AliDNS/DNSPod).
 */
dns.setServers([
  ...ALIDNS_DNS,
  // ...CLOUDFLARE_DNS,
  // ...GOOGLE_DNS,
]);

/**
 * Connects Mongoose to MongoDB.
 * @param {string} uri - The MongoDB connection string.
 * @param {Logger} logger - Logger for connection events.
 * @returns {Promise<mongoose.Connection>} The open connection.
 * @throws {IntegrationError} If MongoDB cannot be reached.
 */
export async function connectMongo(uri: string, logger: Logger): Promise<mongoose.Connection> {
  try {
    mongoose.set('strictQuery', true);
    const connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
    logger.info('MongoDB connected');
    return connection;
  } catch (error) {
    throw new IntegrationError('mongodb', 'Unable to connect to MongoDB', error);
  }
}

/**
 * Checks that MongoDB answers a ping.
 * @param {mongoose.Connection} connection - The Mongoose connection.
 * @returns {Promise<boolean>} True if healthy.
 */
export async function pingMongo(connection: mongoose.Connection): Promise<boolean> {
  try {
    await connection.db?.admin().ping();
    return true;
  } catch {
    return false;
  }
}
