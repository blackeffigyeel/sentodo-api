import { z } from 'zod';
import { uuidSchema } from '../common.schema';

export const listTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.coerce.date().optional(),
  accountId: uuidSchema.optional(),
  type: z
    .enum(['P2P_TRANSFER', 'EXTERNAL_TRANSFER', 'AIRTIME', 'DATA', 'ELECTRICITY', 'EDUCATION', 'TV', 'FOOD', 'FUNDING'])
    .optional(),
  status: z.enum(['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED']).optional(),
});

export const transactionIdParamsSchema = z.object({ id: z.string().min(8).max(64) });
