import type { Transaction } from '../domain/entities.model';
import { AppError, ConflictError, IntegrationError, ServiceUnavailableError } from '../errors/app.errors';
import type { ProviderRegistry } from '../providers/mock/mock.providers';
import type { Repositories } from '../repositories/interfaces/repositories.interface';
import type { AppCommandCentre } from './commandCentre.service';
import { adjustBalance } from './ledger.helper';

/**
 * Settles transactions in the background (BullMQ worker).
 *
 * The HTTP request has already debited the sender and stored the transaction as PROCESSING.
 * Settlement then credits the recipient (p2p) or calls the provider, and marks the transaction
 * SUCCESS, or FAILED with a refund. Every state change uses a compare-and-set on the status,
 * so running the same job twice can never credit or refund twice.
 */
export class SettlementService {
  constructor(
    private readonly repositories: Repositories,
    private readonly providers: ProviderRegistry,
    private readonly commandCentre: AppCommandCentre,
  ) {}

  /**
   * Settles one transaction. Throws for transient problems so the queue retries; permanent
   * failures (provider declines, missing recipient) are refunded and do not throw.
   * @param {string} transactionId - The transaction to settle.
   */
  async settle(transactionId: string): Promise<void> {
    const transaction = await this.repositories.transactions.findById(transactionId);
    if (!transaction || transaction.status !== 'PROCESSING') return;

    try {
      switch (transaction.type) {
        case 'P2P_TRANSFER':
          await this.settleInternalTransfer(transaction);
          break;
        case 'EXTERNAL_TRANSFER':
          await this.settleExternalTransfer(transaction);
          break;
        default:
          await this.settleBill(transaction);
      }
    } catch (error) {
      if (this.isPermanent(error)) {
        await this.failAndRefund(transaction.id, error instanceof Error ? error.message : 'Settlement failed');
        return;
      }
      throw error;
    }
  }

  /**
   * A failure is permanent when retrying cannot help: provider declines and business-rule errors.
   * Command-centre switch-offs and lost optimistic-locking races are transient.
   */
  private isPermanent(error: unknown): boolean {
    if (error instanceof ServiceUnavailableError) return false;
    if (error instanceof IntegrationError) return true;
    return error instanceof AppError && !(error instanceof ConflictError);
  }

  private async settleInternalTransfer(transaction: Transaction): Promise<void> {
    const recipientId = transaction.counterpartyAccountId;
    if (!recipientId) throw new IntegrationError('settlement', 'Missing recipient');
    await this.repositories.unitOfWork.run(async (repos) => {
      const done = await repos.transactions.transition(transaction.id, ['PROCESSING'], 'SUCCESS');
      if (!done) return;
      await adjustBalance(repos, recipientId, transaction.amount, {
        transactionId: transaction.id,
        direction: 'CREDIT',
        description: `Transfer received (${transaction.reference})`,
      });
    });
  }

  private async settleExternalTransfer(transaction: Transaction): Promise<void> {
    const provider = this.providers.transfer;
    await this.commandCentre.assertProvider(provider.id);
    const meta = transaction.metadata ?? {};
    const { providerReference } = await provider.send({
      reference: transaction.reference,
      amount: transaction.amount,
      bankCode: String(meta.bankCode ?? ''),
      accountNumber: String(meta.accountNumber ?? ''),
      accountName: transaction.counterpartyName ?? '',
      narration: transaction.narration ?? undefined,
    });
    await this.repositories.transactions.transition(transaction.id, ['PROCESSING'], 'SUCCESS', { providerReference });
  }

  private async settleBill(transaction: Transaction): Promise<void> {
    const provider = transaction.provider ? this.providers.billById(transaction.provider) : undefined;
    if (!provider) throw new IntegrationError(transaction.provider ?? 'unknown', 'The provider is not available');
    await this.commandCentre.assertProvider(provider.id);

    const meta = transaction.metadata ?? {};
    const result = await provider.purchase({
      reference: transaction.reference,
      amount: transaction.amount,
      customerId: String(meta.customerId ?? ''),
      productCode: meta.productCode ? String(meta.productCode) : undefined,
      metadata: meta,
    });
    await this.repositories.transactions.transition(transaction.id, ['PROCESSING'], 'SUCCESS', {
      providerReference: result.providerReference,
      metadata: { ...meta, ...(result.token ? { token: result.token } : {}), ...(result.details ?? {}) },
    });
  }

  /**
   * Marks a PROCESSING transaction as FAILED and returns the sender's money, atomically.
   * Does nothing if the transaction has already been settled or refunded.
   * @param {string} transactionId - The transaction to fail.
   * @param {string} reason - A safe, client-visible reason.
   */
  async failAndRefund(transactionId: string, reason: string): Promise<void> {
    await this.repositories.unitOfWork.run(async (repos) => {
      const failed = await repos.transactions.transition(transactionId, ['PROCESSING'], 'FAILED', { failureReason: reason });
      if (!failed || failed.totalDebit <= 0) return;
      await adjustBalance(repos, failed.accountId, failed.totalDebit, {
        transactionId: failed.id,
        direction: 'CREDIT',
        description: `Refund (${failed.reference})`,
      });
    });
  }
}
