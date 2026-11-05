import type { Kobo } from '../utils/money.util';

/**
 * Static product catalogue served by the mock providers. Prices are integers in kobo and are
 * representative, not live. Where the catalogue holds the price, the API ignores any amount
 * sent by the client, so customers cannot underpay.
 */

export type Network = 'MTN' | 'AIRTEL' | 'GLO' | '9MOBILE';
export const NETWORKS: readonly Network[] = ['MTN', 'AIRTEL', 'GLO', '9MOBILE'];

/** Airtime limits (the amount is chosen by the customer). */
export const AIRTIME_LIMITS = { min: 5_000 as Kobo, max: 5_000_000 as Kobo };

export interface DataPlan {
  code: string;
  network: Network;
  name: string;
  validity: string;
  price: Kobo;
}

const dataPlan = (network: Network, size: string, validity: string, naira: number): DataPlan => ({
  code: `${network.toLowerCase()}-${size.toLowerCase().replace(/\s/g, '')}-${validity.toLowerCase().replace(/\s/g, '')}`,
  network,
  name: `${size} (${validity})`,
  validity,
  price: naira * 100,
});

export const DATA_PLANS: readonly DataPlan[] = NETWORKS.flatMap((network) => [
  dataPlan(network, '500MB', '30 days', 500),
  dataPlan(network, '1.5GB', '30 days', 1_000),
  dataPlan(network, '3GB', '30 days', 1_500),
  dataPlan(network, '10GB', '30 days', 3_500),
]);

export type Disco = 'IKEDC' | 'EKEDC' | 'AEDC' | 'PHED' | 'IBEDC' | 'KEDCO' | 'EEDC' | 'BEDC' | 'JED' | 'YEDC';
export const DISCOS: ReadonlyArray<{ code: Disco; name: string }> = [
  { code: 'IKEDC', name: 'Ikeja Electric' },
  { code: 'EKEDC', name: 'Eko Electricity Distribution' },
  { code: 'AEDC', name: 'Abuja Electricity Distribution' },
  { code: 'PHED', name: 'Port Harcourt Electricity Distribution' },
  { code: 'IBEDC', name: 'Ibadan Electricity Distribution' },
  { code: 'KEDCO', name: 'Kano Electricity Distribution' },
  { code: 'EEDC', name: 'Enugu Electricity Distribution' },
  { code: 'BEDC', name: 'Benin Electricity Distribution' },
  { code: 'JED', name: 'Jos Electricity Distribution' },
  { code: 'YEDC', name: 'Yola Electricity Distribution' },
];
export const ELECTRICITY_LIMITS = { min: 50_000 as Kobo, max: 20_000_000 as Kobo };

export type EducationExam = 'WAEC_RESULT' | 'NECO_TOKEN' | 'JAMB_UTME' | 'JAMB_DE';
export interface EducationProduct {
  code: EducationExam;
  name: string;
  price: Kobo;
}
export const EDUCATION_PRODUCTS: readonly EducationProduct[] = [
  { code: 'WAEC_RESULT', name: 'WAEC Result Checker PIN', price: 350_000 },
  { code: 'NECO_TOKEN', name: 'NECO Result Token', price: 120_000 },
  { code: 'JAMB_UTME', name: 'JAMB UTME e-PIN', price: 620_000 },
  { code: 'JAMB_DE', name: 'JAMB Direct Entry e-PIN', price: 620_000 },
];

export type TvOperator = 'DSTV' | 'GOTV';
export interface TvBouquet {
  code: string;
  operator: TvOperator;
  name: string;
  price: Kobo;
}
export const TV_BOUQUETS: readonly TvBouquet[] = [
  { code: 'dstv-padi', operator: 'DSTV', name: 'DStv Padi', price: 440_000 },
  { code: 'dstv-yanga', operator: 'DSTV', name: 'DStv Yanga', price: 600_000 },
  { code: 'dstv-confam', operator: 'DSTV', name: 'DStv Confam', price: 1_100_000 },
  { code: 'dstv-compact', operator: 'DSTV', name: 'DStv Compact', price: 1_900_000 },
  { code: 'dstv-premium', operator: 'DSTV', name: 'DStv Premium', price: 4_500_000 },
  { code: 'gotv-smallie', operator: 'GOTV', name: 'GOtv Smallie', price: 190_000 },
  { code: 'gotv-jinja', operator: 'GOTV', name: 'GOtv Jinja', price: 390_000 },
  { code: 'gotv-jolli', operator: 'GOTV', name: 'GOtv Jolli', price: 580_000 },
  { code: 'gotv-max', operator: 'GOTV', name: 'GOtv Max', price: 850_000 },
  { code: 'gotv-supa', operator: 'GOTV', name: 'GOtv Supa', price: 1_140_000 },
];

export interface FoodItem {
  code: string;
  name: string;
  price: Kobo;
}
export interface Restaurant {
  code: string;
  name: string;
  city: string;
  items: readonly FoodItem[];
}
export const DELIVERY_FEE: Kobo = 80_000;
export const RESTAURANTS: readonly Restaurant[] = [
  {
    code: 'mama-put',
    name: 'Mama Put Kitchen',
    city: 'Lagos',
    items: [
      { code: 'jollof-chicken', name: 'Jollof rice and chicken', price: 350_000 },
      { code: 'pounded-yam-egusi', name: 'Pounded yam and egusi', price: 420_000 },
      { code: 'suya-platter', name: 'Suya platter', price: 300_000 },
    ],
  },
  {
    code: 'abuja-grill',
    name: 'Abuja Grill House',
    city: 'Abuja',
    items: [
      { code: 'grilled-fish', name: 'Grilled fish and plantain', price: 480_000 },
      { code: 'fried-rice-turkey', name: 'Fried rice and turkey', price: 400_000 },
    ],
  },
];

export interface Bank {
  code: string;
  name: string;
}

/** A representative list of Nigerian banks using CBN codes. Sentodo MFB is listed for p2p resolution. */
export const BANKS: readonly Bank[] = [
  { code: '044', name: 'Access Bank' },
  { code: '023', name: 'Citibank Nigeria' },
  { code: '050', name: 'Ecobank Nigeria' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '214', name: 'First City Monument Bank' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '030', name: 'Heritage Bank' },
  { code: '082', name: 'Keystone Bank' },
  { code: '999991', name: 'PalmPay' },
  { code: '076', name: 'Polaris Bank' },
  { code: '101', name: 'Providus Bank' },
  { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '068', name: 'Standard Chartered Bank' },
  { code: '232', name: 'Sterling Bank' },
  { code: '100', name: 'Suntrust Bank' },
  { code: '032', name: 'Union Bank of Nigeria' },
  { code: '033', name: 'United Bank for Africa' },
  { code: '215', name: 'Unity Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '057', name: 'Zenith Bank' },
  { code: '090', name: 'Sentodo Microfinance Bank' },
  { code: '50515', name: 'Moniepoint Microfinance Bank' },
  { code: '999992', name: 'OPay' },
];

/** The CBN code that identifies Sentodo accounts (recipients here are treated as p2p). */
export const SENTODO_BANK = BANKS.find((bank) => bank.code === '090') as Bank;

/** Mock identity registry used for BVN verification. Replace with a real provider later. */
export interface MockIdentity {
  bvn: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  phone: string;
}
export const MOCK_IDENTITIES: readonly MockIdentity[] = [
  { bvn: '22222222221', firstName: 'Adaeze', lastName: 'Okonkwo', dateOfBirth: '1992-03-14', phone: '08031234567' },
  { bvn: '22222222222', firstName: 'Tunde', lastName: 'Bakare', dateOfBirth: '1988-11-02', phone: '08122223333' },
  { bvn: '22222222223', firstName: 'Fatima', lastName: 'Bello', dateOfBirth: '1995-07-21', phone: '09012345678' },
  { bvn: '22222222224', firstName: 'Chinedu', lastName: 'Eze', dateOfBirth: '1990-01-30', phone: '07066778899' },
  { bvn: '22222222225', firstName: 'Ngozi', lastName: 'Adeyemi', dateOfBirth: '1985-09-09', phone: '08099887766' },
];

/** Mock TV smart cards. Any other 10-digit IUC is reported as not found. */
export const MOCK_TV_CUSTOMERS: Readonly<Record<TvOperator, ReadonlyArray<{ iuc: string; name: string }>>> = {
  DSTV: [
    { iuc: '7012345678', name: 'OKONKWO ADAEZE C' },
    { iuc: '7023456789', name: 'BAKARE TUNDE O' },
    { iuc: '7034567890', name: 'BELLO FATIMA A' },
  ],
  GOTV: [
    { iuc: '4012345678', name: 'EZE CHINEDU P' },
    { iuc: '4023456789', name: 'ADEYEMI NGOZI K' },
  ],
};
