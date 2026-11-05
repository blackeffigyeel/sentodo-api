import type { RequestHandler } from 'express';
import type { AppContainer } from '../../app.container';
import type { TransactionStatus, TransactionType } from '../../domain/entities.model';
import { requireAuth } from '../../middleware/auth.middleware';
import { toTransactionView } from '../../services/views.mapper';
import { asyncHandler } from '../../utils/asyncHandler.util';
import { sendSuccess } from '../../utils/response.util';

/** HTTP handlers for transaction history. */
export function createTransactionsController(container: AppContainer): Record<string, RequestHandler> {
  const { transactions } = container;
  return {
    list: asyncHandler(async (req, res) => {
      const { profile } = requireAuth(req);
      const query = req.query as unknown as {
        limit: number;
        before?: Date;
        accountId?: string;
        type?: TransactionType;
        status?: TransactionStatus;
      };
      const items = await transactions.list({ profileId: profile.id, ...query });
      const last = items[items.length - 1];
      sendSuccess(res, 200, 'Transactions retrieved', {
        transactions: items.map(toTransactionView),
        nextCursor: items.length === query.limit && last ? last.createdAt : null,
      });
    }),

    get: asyncHandler(async (req, res) => {
      const { profile } = requireAuth(req);
      const transaction = await transactions.getOwned(profile.id, req.params.id);
      sendSuccess(res, 200, 'Transaction retrieved', { transaction: toTransactionView(transaction) });
    }),
  };
}
