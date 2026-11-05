import { z } from 'zod';
import { koboSchema, uuidSchema } from '../common.schema';

export const accountIdParamsSchema = z.object({ id: uuidSchema });
export const createAccountSchema = z.object({ name: z.string().trim().min(2).max(80).optional() });
export const fundAccountSchema = z.object({ amount: koboSchema });
