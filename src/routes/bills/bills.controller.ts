import type { Request, RequestHandler } from 'express';
import type { AppContainer } from '../../app.container';
import {
  AIRTIME_LIMITS,
  DATA_PLANS,
  DELIVERY_FEE,
  DISCOS,
  EDUCATION_PRODUCTS,
  ELECTRICITY_LIMITS,
  NETWORKS,
  RESTAURANTS,
  TV_BOUQUETS,
} from '../../data/catalogue.data';
import { requireAuth } from '../../middleware/auth.middleware';
import type { BillInput } from '../../services/bill.service';
import { toTransactionView } from '../../services/views.mapper';
import { asyncHandler } from '../../utils/asyncHandler.util';
import { toMoneyView } from '../../utils/money.util';
import { sendSuccess } from '../../utils/response.util';
import { readIdempotencyKey } from '../common.schema';

type Category = BillInput['category'];

/** HTTP handlers for bill payments and the product catalogue. */
export function createBillsController(container: AppContainer): Record<string, RequestHandler> {
  const { bills } = container;

  /** Builds a purchase handler for one category. */
  const purchase = (category: Category, message: string): RequestHandler =>
    asyncHandler(async (req: Request, res) => {
      const { profile } = requireAuth(req);
      const input = { ...req.body, category, idempotencyKey: readIdempotencyKey(req) } as BillInput;
      const transaction = await bills.purchase(profile, input);
      sendSuccess(res, 202, message, { transaction: toTransactionView(transaction) });
    });

  return {
    airtime: purchase('AIRTIME', 'Airtime purchase accepted and is being processed'),
    data: purchase('DATA', 'Data purchase accepted and is being processed'),
    electricity: purchase('ELECTRICITY', 'Electricity purchase accepted and is being processed'),
    education: purchase('EDUCATION', 'Education purchase accepted and is being processed'),
    tv: purchase('TV', 'TV subscription accepted and is being processed'),
    food: purchase('FOOD', 'Food order accepted and is being processed'),

    quote: asyncHandler(async (req, res) => {
      const { profile } = requireAuth(req);
      const quote = await bills.quote(profile, req.body as BillInput);
      sendSuccess(res, 200, 'Bill quote', {
        amount: toMoneyView(quote.amount),
        discount: toMoneyView(quote.discount),
        totalDebit: toMoneyView(quote.totalDebit),
        narration: quote.narration,
      });
    }),

    validateTv: asyncHandler(async (req, res) => {
      const { operator, iuc } = req.body as { operator: 'DSTV' | 'GOTV'; iuc: string };
      const result = await bills.validateTvCustomer(operator, iuc);
      sendSuccess(res, 200, 'Smart card validated', { operator, iuc, customerName: result.customerName });
    }),

    airtimeCatalogue: asyncHandler(async (_req, res) => {
      sendSuccess(res, 200, 'Airtime networks', {
        networks: NETWORKS,
        min: toMoneyView(AIRTIME_LIMITS.min),
        max: toMoneyView(AIRTIME_LIMITS.max),
      });
    }),

    dataCatalogue: asyncHandler(async (req, res) => {
      const { network } = req.query as { network?: string };
      const plans = DATA_PLANS.filter((plan) => !network || plan.network === network);
      sendSuccess(res, 200, 'Data plans', { plans: plans.map((plan) => ({ ...plan, price: toMoneyView(plan.price) })) });
    }),

    electricityCatalogue: asyncHandler(async (_req, res) => {
      sendSuccess(res, 200, 'Electricity distributors', {
        discos: DISCOS,
        meterTypes: ['PREPAID', 'POSTPAID'],
        min: toMoneyView(ELECTRICITY_LIMITS.min),
        max: toMoneyView(ELECTRICITY_LIMITS.max),
      });
    }),

    educationCatalogue: asyncHandler(async (_req, res) => {
      sendSuccess(res, 200, 'Education products', {
        products: EDUCATION_PRODUCTS.map((product) => ({ ...product, price: toMoneyView(product.price) })),
      });
    }),

    tvCatalogue: asyncHandler(async (req, res) => {
      const { operator } = req.query as { operator?: string };
      const bouquets = TV_BOUQUETS.filter((bouquet) => !operator || bouquet.operator === operator);
      sendSuccess(res, 200, 'TV bouquets', { bouquets: bouquets.map((b) => ({ ...b, price: toMoneyView(b.price) })) });
    }),

    foodCatalogue: asyncHandler(async (_req, res) => {
      sendSuccess(res, 200, 'Restaurants', {
        deliveryFee: toMoneyView(DELIVERY_FEE),
        restaurants: RESTAURANTS.map((restaurant) => ({
          ...restaurant,
          items: restaurant.items.map((item) => ({ ...item, price: toMoneyView(item.price) })),
        })),
      });
    }),
  };
}
