import type { RequestHandler } from 'express';
import type { AppContainer } from '../../app.container';
import { BANKS } from '../../data/catalogue.data';
import { asyncHandler } from '../../utils/asyncHandler.util';
import { sendSuccess } from '../../utils/response.util';

/** HTTP handlers for the bank list and name enquiry. */
export function createBanksController(container: AppContainer): Record<string, RequestHandler> {
  return {
    list: asyncHandler(async (_req, res) => {
      sendSuccess(res, 200, 'Banks retrieved', { banks: BANKS });
    }),

    resolve: asyncHandler(async (req, res) => {
      const { bankCode, accountNumber } = req.query as { bankCode: string; accountNumber: string };
      const recipient = await container.accounts.resolveRecipient(bankCode, accountNumber);
      sendSuccess(res, 200, 'Account resolved', {
        accountNumber: recipient.accountNumber,
        accountName: recipient.accountName,
        bankCode: recipient.bankCode,
        bankName: recipient.bankName,
        isSentodo: recipient.isSentodo,
      });
    }),
  };
}
