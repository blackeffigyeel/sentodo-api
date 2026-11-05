import { z } from 'zod';

export const verifyIdentitySchema = z.object({
  bvn: z.string().regex(/^\d{11}$/, 'BVN must be exactly 11 digits'),
});
