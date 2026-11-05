import { Router } from 'express';
import { ForbiddenError } from '../../errors/app.errors';
import { COSTS } from '../../rateLimit/rateLimit.policies';
import { validate } from '../../middleware/validate.middleware';
import type { RouteDependencies } from '../routes.types';
import { createApiKeysController } from './apiKeys.controller';
import { apiKeyIdParamsSchema, createApiKeySchema, updateAllowlistSchema } from './apiKeys.schema';

/**
 * Corporate API key management. Keys are managed with a signed-in session (JWT) only,
 * so a leaked API key cannot be used to mint or alter keys.
 */
export function createApiKeysRouter({ container, auth, limit }: RouteDependencies): Router {
  const router = Router();
  const controller = createApiKeysController(container);
  router.use(auth.authenticate);
  router.use((req, _res, next) => {
    if (req.auth?.via !== 'jwt') return next(new ForbiddenError('API keys can only be managed with a signed-in session'));
    return next();
  });
  router.use(auth.requireCorporate);

  router.get('/', limit('standard', { cost: COSTS.read }), controller.list);
  router.post('/', limit('standard', { cost: COSTS.write }), validate(createApiKeySchema), controller.create);
  router.patch(
    '/:id/allowlist',
    limit('standard', { cost: COSTS.write }),
    validate(apiKeyIdParamsSchema, 'params'),
    validate(updateAllowlistSchema),
    controller.updateAllowlist,
  );
  router.delete('/:id', limit('standard', { cost: COSTS.write }), validate(apiKeyIdParamsSchema, 'params'), controller.revoke);

  return router;
}
