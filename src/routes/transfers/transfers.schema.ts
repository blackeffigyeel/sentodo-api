import { z } from 'zod';
import { accountNumberSchema, koboSchema, uuidSchema } from '../common.schema';

const destination = {
  fromAccountId: uuidSchema,
  bankCode: z.string().regex(/^\d{3,6}$/, 'Invalid bank code'),
  accountNumber: accountNumberSchema,
  amount: koboSchema,
};

export const quoteTransferSchema = z.object(destination);

export const createTransferSchema = z.object({
  ...destination,
  narration: z.string().trim().max(100).optional(),
});
