import { Router } from 'express';
import { COSTS } from '../../rateLimit/rateLimit.policies';
import { validate } from '../../middleware/validate.middleware';
import type { RouteDependencies } from '../routes.types';
import { createProfilesController } from './profiles.controller';
import { verifyIdentitySchema } from './profiles.schema';

/** Routes for the signed-in profile. */
export function createProfilesRouter({ container, auth, limit }: RouteDependencies): Router {
  const router = Router();
  const controller = createProfilesController(container);
  router.use(auth.authenticate);

  router.get('/me', limit('standard', { cost: COSTS.read }), controller.me);
  router.post(
    '/me/identity',
    limit('identity', { cost: COSTS.identity }),
    validate(verifyIdentitySchema),
    controller.verifyIdentity,
  );

  return router;
}
