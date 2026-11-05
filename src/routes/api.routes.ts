import { Router } from 'express';
import { createAccountsRouter } from './accounts/accounts.routes';
import { createApiKeysRouter } from './apiKeys/apiKeys.routes';
import { createAuthRouter } from './auth/auth.routes';
import { createBanksRouter } from './banks/banks.routes';
import { createBillsRouter } from './bills/bills.routes';
import { createCommandCentreRouter } from './commandCentre/commandCentre.routes';
import { createProfilesRouter } from './profiles/profiles.routes';
import type { RouteDependencies } from './routes.types';
import { createSystemRouter } from './system/system.routes';
import { createTransactionsRouter } from './transactions/transactions.routes';
import { createTransfersRouter } from './transfers/transfers.routes';

/** Mounts every feature router under its prefix. This is the version 1 API. */
export function createApiRouter(deps: RouteDependencies): Router {
  const router = Router();
  router.use('/health', createSystemRouter(deps));
  router.use('/auth', createAuthRouter(deps));
  router.use('/profiles', createProfilesRouter(deps));
  router.use('/accounts', createAccountsRouter(deps));
  router.use('/banks', createBanksRouter(deps));
  router.use('/transfers', createTransfersRouter(deps));
  router.use('/transactions', createTransactionsRouter(deps));
  router.use('/bills', createBillsRouter(deps));
  router.use('/api-keys', createApiKeysRouter(deps));
  router.use('/command-centre', createCommandCentreRouter(deps));
  return router;
}
