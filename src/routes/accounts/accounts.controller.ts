import type { RequestHandler } from 'express';
import type { AppContainer } from '../../app.container';
import { requireAuth } from '../../middleware/auth.middleware';
import { toAccountView } from '../../services/views.mapper';
import { asyncHandler } from '../../utils/asyncHandler.util';
import { sendSuccess } from '../../utils/response.util';

/** HTTP handlers for accounts. */
export function createAccountsController(container: AppContainer): Record<string, RequestHandler> {
  const { accounts } = container;
  return {
    list: asyncHandler(async (req, res) => {
      const { profile } = requireAuth(req);
      const items = await accounts.listForProfile(profile.id);
      sendSuccess(res, 200, 'Accounts retrieved', { accounts: items.map(toAccountView) });
    }),

    create: asyncHandler(async (req, res) => {
      const { profile } = requireAuth(req);
      const account = await accounts.createForProfile(profile, (req.body as { name?: string }).name);
      sendSuccess(res, 201, 'Account created', { account: toAccountView(account) });
    }),

    get: asyncHandler(async (req, res) => {
      const { profile } = requireAuth(req);
      const account = await accounts.getOwned(profile.id, req.params.id);
      sendSuccess(res, 200, 'Account retrieved', { account: toAccountView(account) });
    }),

    fund: asyncHandler(async (req, res) => {
      const { profile } = requireAuth(req);
      const account = await accounts.sandboxFund(profile, req.params.id, (req.body as { amount: number }).amount);
      sendSuccess(res, 200, 'Account funded (sandbox)', { account: toAccountView(account) });
    }),
  };
}
