import { z } from 'zod';
import { accountNumberSchema } from '../common.schema';

export const resolveAccountQuerySchema = z.object({
  bankCode: z.string().regex(/^\d{3,6}$/, 'Invalid bank code'),
  accountNumber: accountNumberSchema,
});
