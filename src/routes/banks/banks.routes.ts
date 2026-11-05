import { Router } from 'express';
import { COSTS } from '../../rateLimit/rateLimit.policies';
import { validate } from '../../middleware/validate.middleware';
import type { RouteDependencies } from '../routes.types';
import { createBanksController } from './banks.controller';
import { resolveAccountQuerySchema } from './banks.schema';

/** Bank list and account-name enquiry. */
export function createBanksRouter({ container, auth, limit }: RouteDependencies): Router {
  const router = Router();
  const controller = createBanksController(container);
  router.use(auth.authenticate);

  router.get('/', limit('standard', { cost: COSTS.read }), controller.list);
  router.get('/resolve', limit('standard', { cost: COSTS.write }), validate(resolveAccountQuerySchema, 'query'), controller.resolve);

  return router;
}
