import { z } from 'zod';
import { emailSchema, phoneSchema, sixDigitCodeSchema } from '../common.schema';

const passwordSchema = z
  .string()
  .min(8, 'Must be at least 8 characters')
  .max(72, 'Must be at most 72 characters')
  .regex(/[A-Za-z]/, 'Must contain a letter')
  .regex(/\d/, 'Must contain a digit');

export const registerSchema = z
  .object({
    type: z.enum(['INDIVIDUAL', 'CORPORATE']),
    email: emailSchema,
    phone: phoneSchema,
    password: passwordSchema,
    firstName: z.string().trim().min(1).max(60).optional(),
    lastName: z.string().trim().min(1).max(60).optional(),
    businessName: z.string().trim().min(2).max(120).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'INDIVIDUAL') {
      if (!value.firstName) ctx.addIssue({ code: 'custom', path: ['firstName'], message: 'Required for individual profiles' });
      if (!value.lastName) ctx.addIssue({ code: 'custom', path: ['lastName'], message: 'Required for individual profiles' });
    } else if (!value.businessName) {
      ctx.addIssue({ code: 'custom', path: ['businessName'], message: 'Required for corporate profiles' });
    }
  });

export const verifyEmailSchema = z.object({ email: emailSchema, code: sixDigitCodeSchema });
export const verifyPhoneSchema = z.object({ phone: phoneSchema, code: sixDigitCodeSchema });
export const resendEmailCodeSchema = z.object({ email: emailSchema });
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(72) });
export const verifyTokenSchema = z.object({ token: z.string().min(10).max(4096) });
