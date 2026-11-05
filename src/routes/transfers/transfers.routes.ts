import { Router } from 'express';
import { COSTS } from '../../rateLimit/rateLimit.policies';
import { validate } from '../../middleware/validate.middleware';
import type { RouteDependencies } from '../routes.types';
import { createTransfersController } from './transfers.controller';
import { createTransferSchema, quoteTransferSchema } from './transfers.schema';

/** Transfer routes. Creating a transfer returns 202 immediately; settlement runs in a queue. */
export function createTransfersRouter({ container, auth, limit }: RouteDependencies): Router {
  const router = Router();
  const controller = createTransfersController(container);
  router.use(auth.authenticate);

  router.post('/quote', limit('standard', { cost: COSTS.write }), validate(quoteTransferSchema), controller.quote);
  router.post('/', limit('transactions', { cost: COSTS.transfer }), validate(createTransferSchema), controller.create);

  return router;
}
