import mongoose from 'mongoose';
import { IntegrationError } from '../errors/app.errors';
import type { Logger } from '../utils/logger.util';

/**
 * MongoDB integration (Mongoose). This is the only module that opens the Mongo connection.
 * MongoDB holds non-financial, high-churn data: verification codes, audit logs and command-centre state.
 */

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
