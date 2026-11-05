import {
  EDUCATION_PRODUCTS,
  MOCK_IDENTITIES,
  MOCK_TV_CUSTOMERS,
  NETWORKS,
  DISCOS,
  RESTAURANTS,
  TV_BOUQUETS,
  type EducationExam,
  type Network,
  type TvOperator,
} from '../../data/catalogue.data';
import { IntegrationError } from '../../errors/app.errors';
import { sha256 } from '../../utils/crypto.util';
import type {
  BillCategory,
  BillProvider,
  CustomerValidation,
  IdentityProvider,
  IdentityRecord,
  PurchaseRequest,
  PurchaseResult,
  SmsProvider,
  TransferProvider,
  TransferRequest,
} from '../provider.types';

/**
 * Mock providers. They behave like real aggregators (deterministic results, simulated latency,
 * declines) without leaving the process.
 *
 * Deterministic failure trigger for testing: any customer identifier or account number that
 * ends in "0000" is declined by the provider.
 */

/** Options shared by mock providers. */
export interface MockOptions {
  /** Simulated network latency in milliseconds. */
  latencyMs: number;
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** Builds a stable numeric string from a seed, so repeated calls with one reference match (idempotency). */
function digitsFrom(seed: string, length: number): string {
  const hex = sha256(seed);
  let digits = '';
  for (const char of hex) digits += (parseInt(char, 16) % 10).toString();
  return digits.slice(0, length);
}

/**
 * Builds a provider identifier.
 * @param {string} category - The category or rail, e.g. "tv".
 * @param {string} key - The product key, e.g. "DSTV" or "WAEC_RESULT".
 * @returns {string} For example "mock-tv-dstv" or "mock-education-waec-result".
 */
export function providerId(category: string, key: string): string {
  return `mock-${category.toLowerCase()}-${key.toLowerCase().replace(/_/g, '-')}`;
}

/** Declines the purchase when the customer identifier matches the failure trigger. */
function declineIfTriggered(id: string, customerId: string): void {
  if (customerId.endsWith('0000')) {
    throw new IntegrationError(id, 'The provider declined the request');
  }
}

/** Shared base for bill providers: latency, decline trigger, reference generation. */
abstract class MockBillProvider implements BillProvider {
  abstract readonly category: BillCategory;

  constructor(
    readonly id: string,
    readonly name: string,
    protected readonly options: MockOptions,
  ) {}

  /** Returns provider-specific extras (token, details) for a successful purchase. */
  protected extras(_request: PurchaseRequest): Pick<PurchaseResult, 'token' | 'details'> {
    return {};
  }

  async purchase(request: PurchaseRequest): Promise<PurchaseResult> {
    await sleep(this.options.latencyMs);
    declineIfTriggered(this.id, request.customerId);
    return {
      providerReference: `${this.id.toUpperCase()}-${digitsFrom(request.reference, 10)}`,
      ...this.extras(request),
    };
  }
}

export class MockAirtimeProvider extends MockBillProvider {
  readonly category = 'AIRTIME' as const;
  constructor(network: Network, options: MockOptions) {
    super(providerId('airtime', network), `${network} Airtime (mock)`, options);
  }
}

export class MockDataProvider extends MockBillProvider {
  readonly category = 'DATA' as const;
  constructor(network: Network, options: MockOptions) {
    super(providerId('data', network), `${network} Data (mock)`, options);
  }
}

export class MockElectricityProvider extends MockBillProvider {
  readonly category = 'ELECTRICITY' as const;
  constructor(disco: string, options: MockOptions) {
    super(providerId('electricity', disco), `${disco} Electricity (mock)`, options);
  }

  protected override extras(request: PurchaseRequest): Pick<PurchaseResult, 'token' | 'details'> {
    const digits = digitsFrom(`token:${request.reference}`, 20);
    const token = digits.match(/.{4}/g)?.join('-');
    return { token, details: { units: 'Estimated from tariff', meterNumber: request.customerId } };
  }
}

export class MockEducationProvider extends MockBillProvider {
  readonly category = 'EDUCATION' as const;
  constructor(exam: EducationExam, options: MockOptions) {
    super(providerId('education', exam), `${exam} (mock)`, options);
  }

  protected override extras(request: PurchaseRequest): Pick<PurchaseResult, 'token' | 'details'> {
    return { token: digitsFrom(`pin:${request.reference}`, 12), details: { instructions: 'Use the PIN on the exam body portal' } };
  }
}

export class MockTvProvider extends MockBillProvider {
  readonly category = 'TV' as const;
  constructor(private readonly operator: TvOperator, options: MockOptions) {
    super(providerId('tv', operator), `${operator} (mock)`, options);
  }

  async validateCustomer(customerId: string): Promise<CustomerValidation> {
    await sleep(this.options.latencyMs);
    const match = MOCK_TV_CUSTOMERS[this.operator].find((customer) => customer.iuc === customerId);
    return match ? { valid: true, customerName: match.name } : { valid: false };
  }

  override async purchase(request: PurchaseRequest): Promise<PurchaseResult> {
    const validation = await this.validateCustomer(request.customerId);
    if (!validation.valid) throw new IntegrationError(this.id, 'The smart card number was not recognised');
    return super.purchase(request);
  }
}

export class MockFoodProvider extends MockBillProvider {
  readonly category = 'FOOD' as const;
  constructor(restaurantCode: string, options: MockOptions) {
    super(providerId('food', restaurantCode), `${restaurantCode} (mock)`, options);
  }

  protected override extras(request: PurchaseRequest): Pick<PurchaseResult, 'token' | 'details'> {
    return { token: `ORD-${digitsFrom(`order:${request.reference}`, 6)}`, details: { estimatedMinutes: 40 } };
  }
}

const MOCK_ACCOUNT_NAMES = [
  'OLUWASEUN ADEBAYO', 'CHIOMA NWANKWO', 'IBRAHIM MUSA', 'BLESSING UDOH', 'EMEKA OKAFOR',
  'AISHA YUSUF', 'FOLAKE BALOGUN', 'KELECHI IWU', 'SAMUEL OGUNDIPE', 'HAUWA ABDULLAHI',
];

/** Mock interbank rail with deterministic account-name resolution. */
export class MockTransferProvider implements TransferProvider {
  readonly id = 'mock-nip-transfer';
  readonly name = 'Interbank transfer (mock)';

  constructor(private readonly options: MockOptions) {}

  async resolveAccount(bankCode: string, accountNumber: string): Promise<{ accountName: string }> {
    await sleep(this.options.latencyMs);
    if (accountNumber.endsWith('9999')) {
      throw new IntegrationError(this.id, 'The account could not be resolved');
    }
    const index = Number(digitsFrom(`${bankCode}:${accountNumber}`, 3)) % MOCK_ACCOUNT_NAMES.length;
    return { accountName: MOCK_ACCOUNT_NAMES[index] };
  }

  async send(request: TransferRequest): Promise<{ providerReference: string }> {
    await sleep(this.options.latencyMs);
    declineIfTriggered(this.id, request.accountNumber);
    return { providerReference: `NIP-${digitsFrom(request.reference, 14)}` };
  }
}

/** Mock BVN registry backed by {@link MOCK_IDENTITIES}. */
export class MockIdentityProvider implements IdentityProvider {
  readonly id = 'mock-identity-bvn';
  readonly name = 'BVN verification (mock)';

  constructor(private readonly options: MockOptions) {}

  async lookupBvn(bvn: string): Promise<IdentityRecord | null> {
    await sleep(this.options.latencyMs);
    return MOCK_IDENTITIES.find((identity) => identity.bvn === bvn) ?? null;
  }
}

/** Mock SMS gateway: a phone code is valid if it is in the configured list of 6-digit codes. */
export class MockSmsProvider implements SmsProvider {
  readonly id = 'mock-sms';
  readonly name = 'SMS verification (mock)';

  constructor(private readonly allowedCodes: readonly string[]) {}

  async verifyCode(_phone: string, code: string): Promise<boolean> {
    return this.allowedCodes.includes(code);
  }
}

/** Everything the services need from providers, resolved by identifier or product. */
export class ProviderRegistry {
  private readonly bills = new Map<string, BillProvider>();

  constructor(
    billProviders: BillProvider[],
    readonly transfer: TransferProvider,
    readonly identity: IdentityProvider,
    readonly sms: SmsProvider,
  ) {
    for (const provider of billProviders) this.bills.set(provider.id, provider);
  }

  /**
   * Finds the bill provider for a product.
   * @param {BillCategory} category - The bill category.
   * @param {string} key - Network, disco, exam, operator or restaurant code.
   * @returns {BillProvider | undefined} The provider, or undefined if none is registered.
   */
  bill(category: BillCategory, key: string): BillProvider | undefined {
    return this.bills.get(providerId(category, key));
  }

  /** Finds a bill provider by its identifier (used when settling a stored transaction). */
  billById(id: string): BillProvider | undefined {
    return this.bills.get(id);
  }

  /** Every provider, for seeding and reporting by the command centre. */
  list(): Array<{ id: string; name: string; category: string }> {
    return [
      ...[...this.bills.values()].map((p) => ({ id: p.id, name: p.name, category: p.category })),
      { id: this.transfer.id, name: this.transfer.name, category: 'TRANSFER' },
      { id: this.identity.id, name: this.identity.name, category: 'IDENTITY' },
      { id: this.sms.id, name: this.sms.name, category: 'SMS' },
    ];
  }
}

/**
 * Builds the registry of mock providers.
 * @param {object} options - Registry options.
 * @param {readonly string[]} options.mockPhoneCodes - Accepted 6-digit phone codes.
 * @param {number} [options.latencyMs=0] - Simulated latency per provider call.
 * @returns {ProviderRegistry} The registry.
 */
export function createMockProviderRegistry(options: { mockPhoneCodes: readonly string[]; latencyMs?: number }): ProviderRegistry {
  const mock: MockOptions = { latencyMs: options.latencyMs ?? 0 };
  const bills: BillProvider[] = [
    ...NETWORKS.flatMap((network) => [new MockAirtimeProvider(network, mock), new MockDataProvider(network, mock)]),
    ...DISCOS.map((disco) => new MockElectricityProvider(disco.code, mock)),
    ...EDUCATION_PRODUCTS.map((product) => new MockEducationProvider(product.code, mock)),
    ...(['DSTV', 'GOTV'] as const).map((operator) => new MockTvProvider(operator, mock)),
    ...RESTAURANTS.map((restaurant) => new MockFoodProvider(restaurant.code, mock)),
  ];
  // Referenced so the catalogue stays the single source of TV products.
  void TV_BOUQUETS;
  return new ProviderRegistry(bills, new MockTransferProvider(mock), new MockIdentityProvider(mock), new MockSmsProvider(options.mockPhoneCodes));
}
