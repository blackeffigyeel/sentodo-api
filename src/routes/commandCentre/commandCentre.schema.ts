import { z } from 'zod';

export const stateKeyParamsSchema = z.object({ key: z.string().min(2).max(120).regex(/^[\w.:-]+$/) });
export const setStateSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().max(200).optional(),
});
