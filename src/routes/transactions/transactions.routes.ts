import { Router } from 'express';
import { COSTS } from '../../rateLimit/rateLimit.policies';
import { validate } from '../../middleware/validate.middleware';
import type { RouteDependencies } from '../routes.types';
import { createTransactionsController } from './transactions.controller';
import { listTransactionsQuerySchema, transactionIdParamsSchema } from './transactions.schema';

/** Transaction history. Clients poll `GET /transactions/:id` to see PROCESSING become SUCCESS or FAILED. */
export function createTransactionsRouter({ container, auth, limit }: RouteDependencies): Router {
  const router = Router();
  const controller = createTransactionsController(container);
  router.use(auth.authenticate);

  router.get('/', limit('standard', { cost: COSTS.read }), validate(listTransactionsQuerySchema, 'query'), controller.list);
  router.get('/:id', limit('standard', { cost: COSTS.read }), validate(transactionIdParamsSchema, 'params'), controller.get);

  return router;
}
