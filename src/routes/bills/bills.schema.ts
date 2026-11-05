import { z } from 'zod';
import { NETWORKS } from '../../data/catalogue.data';
import { DISCOS } from '../../data/catalogue.data';
import { koboSchema, phoneSchema, uuidSchema } from '../common.schema';

const from = { fromAccountId: uuidSchema };
const network = z.enum(NETWORKS as unknown as [string, ...string[]]);
const iuc = z.string().regex(/^\d{10}$/, 'IUC number must be exactly 10 digits');
const operator = z.enum(['DSTV', 'GOTV']);

export const airtimeSchema = z.object({ ...from, network, phone: phoneSchema, amount: koboSchema });
export const dataSchema = z.object({ ...from, planCode: z.string().min(3).max(60), phone: phoneSchema });
export const electricitySchema = z.object({
  ...from,
  disco: z.enum(DISCOS.map((disco) => disco.code) as [string, ...string[]]),
  meterNumber: z.string().regex(/^\d{11,13}$/, 'Meter number must be 11 to 13 digits'),
  meterType: z.enum(['PREPAID', 'POSTPAID']),
  amount: koboSchema,
});
export const educationSchema = z.object({ ...from, productCode: z.string().min(3).max(40), phone: phoneSchema });
export const tvSchema = z.object({ ...from, operator, iuc, bouquetCode: z.string().min(3).max(40) });
export const foodSchema = z.object({
  ...from,
  restaurantCode: z.string().min(2).max(40),
  items: z.array(z.object({ code: z.string().min(2).max(60), quantity: z.number().int().min(1).max(20) })).min(1).max(20),
  deliveryPhone: phoneSchema,
});

export const validateTvSchema = z.object({ operator, iuc });
export const dataCatalogueQuerySchema = z.object({ network: network.optional() });
export const tvCatalogueQuerySchema = z.object({ operator: operator.optional() });

/** A quote accepts any one of the purchase bodies, discriminated by `category`. */
export const quoteBillSchema = z.discriminatedUnion('category', [
  airtimeSchema.extend({ category: z.literal('AIRTIME') }),
  dataSchema.extend({ category: z.literal('DATA') }),
  electricitySchema.extend({ category: z.literal('ELECTRICITY') }),
  educationSchema.extend({ category: z.literal('EDUCATION') }),
  tvSchema.extend({ category: z.literal('TV') }),
  foodSchema.extend({ category: z.literal('FOOD') }),
]);
