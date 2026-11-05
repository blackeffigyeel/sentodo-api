import type { RequestHandler } from 'express';
import type { AppContainer } from '../../app.container';
import { requireAuth } from '../../middleware/auth.middleware';
import type { TransferInput } from '../../services/transfer.service';
import { toTransactionView } from '../../services/views.mapper';
import { asyncHandler } from '../../utils/asyncHandler.util';
import { toMoneyView } from '../../utils/money.util';
import { sendSuccess } from '../../utils/response.util';
import { readIdempotencyKey } from '../common.schema';

/** HTTP handlers for transfers. */
export function createTransfersController(container: AppContainer): Record<string, RequestHandler> {
  const { transfers } = container;
  return {
    quote: asyncHandler(async (req, res) => {
      const { profile } = requireAuth(req);
      const quote = await transfers.quote(profile, req.body as TransferInput);
      sendSuccess(res, 200, 'Transfer quote', {
        amount: toMoneyView(quote.amount),
        fee: {
          waived: quote.fee.waived,
          base: toMoneyView(quote.fee.baseFee),
          surcharge: toMoneyView(quote.fee.surcharge),
          vat: toMoneyView(quote.fee.vat),
          total: toMoneyView(quote.fee.total),
        },
        totalDebit: toMoneyView(quote.totalDebit),
        freeTransfersRemaining: quote.freeTransfersRemaining,
        recipient: quote.recipient,
      });
    }),

    create: asyncHandler(async (req, res) => {
      const { profile } = requireAuth(req);
      const transaction = await transfers.initiate(profile, {
        ...(req.body as TransferInput),
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, 202, 'Transfer accepted and is being processed', { transaction: toTransactionView(transaction) });
    }),
  };
}
