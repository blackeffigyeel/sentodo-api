import { Router } from 'express';
import { validate } from '../../middleware/validate.middleware';
import type { RouteDependencies } from '../routes.types';
import { createAuthController } from './auth.controller';
import {
  loginSchema,
  registerSchema,
  resendEmailCodeSchema,
  verifyEmailSchema,
  verifyPhoneSchema,
  verifyTokenSchema,
} from './auth.schema';

/** Public authentication routes. All are limited by IP with the strict "auth" policy. */
export function createAuthRouter({ container, limit }: RouteDependencies): Router {
  const router = Router();
  const controller = createAuthController(container);
  router.use(limit('auth', { byIp: true }));

  router.post('/register', validate(registerSchema), controller.register);
  router.post('/verify-email', validate(verifyEmailSchema), controller.verifyEmail);
  router.post('/verify-phone', validate(verifyPhoneSchema), controller.verifyPhone);
  router.post('/resend-email-code', validate(resendEmailCodeSchema), controller.resendEmailCode);
  router.post('/login', validate(loginSchema), controller.login);
  router.post('/verify-token', validate(verifyTokenSchema), controller.verifyToken);

  return router;
}
