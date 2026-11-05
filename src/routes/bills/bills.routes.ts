import { Router } from 'express';
import { COSTS } from '../../rateLimit/rateLimit.policies';
import { validate } from '../../middleware/validate.middleware';
import type { RouteDependencies } from '../routes.types';
import { createBillsController } from './bills.controller';
import {
  airtimeSchema,
  dataCatalogueQuerySchema,
  dataSchema,
  educationSchema,
  electricitySchema,
  foodSchema,
  quoteBillSchema,
  tvCatalogueQuerySchema,
  tvSchema,
  validateTvSchema,
} from './bills.schema';

/** Bill payment routes: airtime, data, electricity, education, TV and food. */
export function createBillsRouter({ container, auth, limit }: RouteDependencies): Router {
  const router = Router();
  const controller = createBillsController(container);
  router.use(auth.authenticate);

  const read = limit('standard', { cost: COSTS.read });
  const buy = limit('transactions', { cost: COSTS.purchase });

  router.get('/catalogue/airtime', read, controller.airtimeCatalogue);
  router.get('/catalogue/data', read, validate(dataCatalogueQuerySchema, 'query'), controller.dataCatalogue);
  router.get('/catalogue/electricity', read, controller.electricityCatalogue);
  router.get('/catalogue/education', read, controller.educationCatalogue);
  router.get('/catalogue/tv', read, validate(tvCatalogueQuerySchema, 'query'), controller.tvCatalogue);
  router.get('/catalogue/food', read, controller.foodCatalogue);

  router.post('/tv/validate', limit('standard', { cost: COSTS.write }), validate(validateTvSchema), controller.validateTv);
  router.post('/quote', limit('standard', { cost: COSTS.write }), validate(quoteBillSchema), controller.quote);

  router.post('/airtime', buy, validate(airtimeSchema), controller.airtime);
  router.post('/data', buy, validate(dataSchema), controller.data);
  router.post('/electricity', buy, validate(electricitySchema), controller.electricity);
  router.post('/education', buy, validate(educationSchema), controller.education);
  router.post('/tv', buy, validate(tvSchema), controller.tv);
  router.post('/food', buy, validate(foodSchema), controller.food);

  return router;
}
