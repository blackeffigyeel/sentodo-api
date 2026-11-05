import {
  AIRTIME_LIMITS,
  DATA_PLANS,
  DELIVERY_FEE,
  DISCOS,
  EDUCATION_PRODUCTS,
  ELECTRICITY_LIMITS,
  RESTAURANTS,
  TV_BOUQUETS,
  type Network,
  type TvOperator,
} from '../data/catalogue.data';
import type { Profile, Transaction, TransactionType } from '../domain/entities.model';
import { calculateBillDiscount } from '../domain/pricing.rules';
import { BadRequestError, NotFoundError } from '../errors/app.errors';
import type { ProviderRegistry } from '../providers/mock/mock.providers';
import type { BillCategory } from '../providers/provider.types';
import { addKobo, type Kobo } from '../utils/money.util';
import { isValidIucNumber } from '../utils/nigeria.util';
import type { AccountService } from './account.service';
import type { AppCommandCentre, FeatureKey } from './commandCentre.service';
import type { TransactionService } from './transaction.service';

/** Fields common to every bill payment. */
interface BillBase {
  fromAccountId: string;
  idempotencyKey?: string;
}

/** A validated bill payment request. */
export type BillInput = BillBase &
  (
    | { category: 'AIRTIME'; network: Network; phone: string; amount: Kobo }
    | { category: 'DATA'; planCode: string; phone: string }
    | { category: 'ELECTRICITY'; disco: string; meterNumber: string; meterType: 'PREPAID' | 'POSTPAID'; amount: Kobo }
    | { category: 'EDUCATION'; productCode: string; phone: string }
    | { category: 'TV'; operator: TvOperator; iuc: string; bouquetCode: string }
    | { category: 'FOOD'; restaurantCode: string; items: Array<{ code: string; quantity: number }>; deliveryPhone: string }
  );

/** The priced, provider-bound form of a bill request. */
interface BillQuote {
  category: BillCategory;
  providerKey: string;
  amount: Kobo;
  customerId: string;
  productCode?: string;
  narration: string;
  metadata: Record<string, unknown>;
}

const TYPE_BY_CATEGORY: Record<BillCategory, TransactionType> = {
  AIRTIME: 'AIRTIME',
  DATA: 'DATA',
  ELECTRICITY: 'ELECTRICITY',
  EDUCATION: 'EDUCATION',
  TV: 'TV',
  FOOD: 'FOOD',
};

/**
 * Airtime, data, electricity, education, TV and food purchases.
 *
 * Catalogue prices are authoritative: where the product has a fixed price the client-supplied
 * amount is never used. Discounts depend on the profile type (individual or corporate).
 * Only TV supports customer validation, so the customer name can be shown before paying.
 */
export class BillService {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly accounts: AccountService,
    private readonly transactions: TransactionService,
    private readonly commandCentre: AppCommandCentre,
  ) {}

  /**
   * Validates a TV smart card and returns the customer name.
   * @param {TvOperator} operator - DSTV or GOTV.
   * @param {string} iuc - The 10-digit smart card (IUC) number.
   * @returns {Promise<{ customerName: string }>} The name on the account.
   * @throws {NotFoundError} If the smart card is not recognised.
   */
  async validateTvCustomer(operator: TvOperator, iuc: string): Promise<{ customerName: string }> {
    await this.commandCentre.assertFeature('bills.tv');
    if (!isValidIucNumber(iuc)) throw new BadRequestError('IUC number must be exactly 10 digits');
    const provider = this.providers.bill('TV', operator);
    if (!provider?.validateCustomer) throw new BadRequestError('Validation is not available for this operator');
    await this.commandCentre.assertProvider(provider.id);

    const result = await provider.validateCustomer(iuc);
    if (!result.valid || !result.customerName) throw new NotFoundError('Smart card number not found');
    return { customerName: result.customerName };
  }

  private quoteFor(input: BillInput): BillQuote {
    switch (input.category) {
      case 'AIRTIME': {
        if (input.amount < AIRTIME_LIMITS.min || input.amount > AIRTIME_LIMITS.max) {
          throw new BadRequestError('Airtime must be between NGN 50 and NGN 50,000');
        }
        return {
          category: 'AIRTIME',
          providerKey: input.network,
          amount: input.amount,
          customerId: input.phone,
          narration: `${input.network} airtime for ${input.phone}`,
          metadata: { network: input.network, customerId: input.phone },
        };
      }
      case 'DATA': {
        const plan = DATA_PLANS.find((candidate) => candidate.code === input.planCode);
        if (!plan) throw new NotFoundError('Data plan not found');
        return {
          category: 'DATA',
          providerKey: plan.network,
          amount: plan.price,
          customerId: input.phone,
          productCode: plan.code,
          narration: `${plan.network} ${plan.name} for ${input.phone}`,
          metadata: { network: plan.network, plan: plan.name, customerId: input.phone, productCode: plan.code },
        };
      }
      case 'ELECTRICITY': {
        const disco = DISCOS.find((candidate) => candidate.code === input.disco);
        if (!disco) throw new NotFoundError('Electricity distributor not found');
        if (input.amount < ELECTRICITY_LIMITS.min || input.amount > ELECTRICITY_LIMITS.max) {
          throw new BadRequestError('Electricity purchases must be between NGN 500 and NGN 200,000');
        }
        return {
          category: 'ELECTRICITY',
          providerKey: disco.code,
          amount: input.amount,
          customerId: input.meterNumber,
          productCode: input.meterType,
          narration: `${disco.name} ${input.meterType.toLowerCase()} meter ${input.meterNumber}`,
          metadata: { disco: disco.code, meterType: input.meterType, customerId: input.meterNumber, productCode: input.meterType },
        };
      }
      case 'EDUCATION': {
        const product = EDUCATION_PRODUCTS.find((candidate) => candidate.code === input.productCode);
        if (!product) throw new NotFoundError('Education product not found');
        return {
          category: 'EDUCATION',
          providerKey: product.code,
          amount: product.price,
          customerId: input.phone,
          productCode: product.code,
          narration: product.name,
          metadata: { product: product.name, customerId: input.phone, productCode: product.code },
        };
      }
      case 'TV': {
        const bouquet = TV_BOUQUETS.find((candidate) => candidate.code === input.bouquetCode && candidate.operator === input.operator);
        if (!bouquet) throw new NotFoundError('Bouquet not found for this operator');
        return {
          category: 'TV',
          providerKey: bouquet.operator,
          amount: bouquet.price,
          customerId: input.iuc,
          productCode: bouquet.code,
          narration: `${bouquet.name} for ${input.iuc}`,
          metadata: { operator: bouquet.operator, bouquet: bouquet.name, customerId: input.iuc, productCode: bouquet.code },
        };
      }
      case 'FOOD': {
        const restaurant = RESTAURANTS.find((candidate) => candidate.code === input.restaurantCode);
        if (!restaurant) throw new NotFoundError('Restaurant not found');
        const lines = input.items.map((requested) => {
          const item = restaurant.items.find((candidate) => candidate.code === requested.code);
          if (!item) throw new NotFoundError(`Menu item "${requested.code}" not found`);
          return { item, quantity: requested.quantity, subtotal: item.price * requested.quantity };
        });
        const amount = addKobo(DELIVERY_FEE, ...lines.map((line) => line.subtotal));
        return {
          category: 'FOOD',
          providerKey: restaurant.code,
          amount,
          customerId: input.deliveryPhone,
          narration: `${restaurant.name} order`,
          metadata: {
            restaurant: restaurant.name,
            customerId: input.deliveryPhone,
            deliveryFee: DELIVERY_FEE,
            items: lines.map((line) => ({ code: line.item.code, name: line.item.name, quantity: line.quantity, subtotal: line.subtotal })),
          },
        };
      }
    }
  }

  /**
   * Prices a bill without charging anything.
   * @param {Profile} profile - The buyer.
   * @param {BillInput} input - The bill request.
   * @returns {Promise<{ amount: Kobo; discount: Kobo; totalDebit: Kobo; narration: string }>} The price breakdown.
   */
  async quote(profile: Profile, input: BillInput): Promise<{ amount: Kobo; discount: Kobo; totalDebit: Kobo; narration: string }> {
    const quote = this.quoteFor(input);
    const discount = calculateBillDiscount(quote.amount, profile.type);
    return { amount: quote.amount, discount, totalDebit: quote.amount - discount, narration: quote.narration };
  }

  /**
   * Buys a bill. The account is debited immediately and the provider is called by the queue worker.
   * @param {Profile} profile - The buyer.
   * @param {BillInput} input - The bill request.
   * @returns {Promise<Transaction>} The transaction in PROCESSING state.
   */
  async purchase(profile: Profile, input: BillInput): Promise<Transaction> {
    this.transactions.assertCanTransact(profile);
    const repeat = await this.transactions.findByIdempotencyKey(profile.id, input.idempotencyKey);
    if (repeat) return repeat;

    const quote = this.quoteFor(input);
    const feature = `bills.${quote.category.toLowerCase()}` as FeatureKey;
    await this.commandCentre.assertFeature(feature);

    const provider = this.providers.bill(quote.category, quote.providerKey);
    if (!provider) throw new NotFoundError('No provider is available for this product');
    await this.commandCentre.assertProvider(provider.id);

    if (input.category === 'TV') await this.validateTvCustomer(input.operator, input.iuc);

    const account = await this.accounts.getOwned(profile.id, input.fromAccountId);
    const discount = calculateBillDiscount(quote.amount, profile.type);

    return this.transactions.submit({
      profile,
      account,
      type: TYPE_BY_CATEGORY[quote.category],
      amount: quote.amount,
      discount,
      idempotencyKey: input.idempotencyKey,
      provider: provider.id,
      narration: quote.narration,
      metadata: { ...quote.metadata, discount },
      description: quote.narration,
    });
  }
}
