import { z } from 'zod';
import { uuidSchema } from '../common.schema';

const ips = z.array(z.string().trim().min(3).max(45)).min(1).max(20);

export const createApiKeySchema = z.object({ name: z.string().trim().min(2).max(60), allowedIps: ips });
export const updateAllowlistSchema = z.object({ allowedIps: ips });
export const apiKeyIdParamsSchema = z.object({ id: uuidSchema });
