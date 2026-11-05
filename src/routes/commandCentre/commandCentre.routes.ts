import { Router } from 'express';
import { COSTS } from '../../rateLimit/rateLimit.policies';
import { validate } from '../../middleware/validate.middleware';
import type { RouteDependencies } from '../routes.types';
import { createCommandCentreController } from './commandCentre.controller';
import { setStateSchema, stateKeyParamsSchema } from './commandCentre.schema';

/**
 * Command centre routes.
 * Reading states is open to any authorised client (service token, JWT or API key);
 * changing them needs the internal service token.
 */
export function createCommandCentreRouter({ container, auth, limit }: RouteDependencies): Router {
  const router = Router();
  const controller = createCommandCentreController(container);

  router.get('/states', auth.authenticateClient, limit('standard', { cost: COSTS.read }), controller.states);
  router.patch(
    '/states/:key',
    auth.requireServiceToken,
    limit('standard', { cost: COSTS.write }),
    validate(stateKeyParamsSchema, 'params'),
    validate(setStateSchema),
    controller.setState,
  );

  return router;
}
