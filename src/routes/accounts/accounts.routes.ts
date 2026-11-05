import { Router } from 'express';
import { COSTS } from '../../rateLimit/rateLimit.policies';
import { validate } from '../../middleware/validate.middleware';
import type { RouteDependencies } from '../routes.types';
import { createAccountsController } from './accounts.controller';
import { accountIdParamsSchema, createAccountSchema, fundAccountSchema } from './accounts.schema';

/** Account routes. Accounts are owned by profiles; a profile may hold several. */
export function createAccountsRouter({ container, auth, limit }: RouteDependencies): Router {
  const router = Router();
  const controller = createAccountsController(container);
  router.use(auth.authenticate);

  router.get('/', limit('standard', { cost: COSTS.read }), controller.list);
  router.post('/', limit('standard', { cost: COSTS.write }), validate(createAccountSchema), controller.create);
  router.get('/:id', limit('standard', { cost: COSTS.read }), validate(accountIdParamsSchema, 'params'), controller.get);
  router.post(
    '/:id/fund',
    limit('standard', { cost: COSTS.write }),
    validate(accountIdParamsSchema, 'params'),
    validate(fundAccountSchema),
    controller.fund,
  );

  return router;
}
