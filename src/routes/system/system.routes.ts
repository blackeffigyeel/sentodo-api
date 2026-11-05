import { Router } from 'express';
import type { RouteDependencies } from '../routes.types';
import { createSystemController } from './system.controller';

/** Unauthenticated health probes. */
export function createSystemRouter({ container }: RouteDependencies): Router {
  const router = Router();
  const controller = createSystemController(container);
  router.get('/', controller.live);
  router.get('/ready', controller.ready);
  return router;
}
