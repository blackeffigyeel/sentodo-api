# Sentodo MFB API

TypeScript API for Sentodo Microfinance Bank: airtime, data, electricity, education, TV and food purchases, plus p2p and external transfers. Individuals and companies (via API keys) use the same API.

* Interactive docs: `/docs` (OpenAPI at `/docs/openapi.json`, source `docs/sentodo.api.doc.yaml`)
* Corporate users: [`docs/corporate.guide.doc.md`](docs/corporate.guide.doc.md)

## Quick start

```bash
cp .env.example .env        # set JWT_SECRET and ADMIN_SERVICE_TOKEN (16+ characters)
docker compose up --build   # api, worker, postgres, mongo, redis, mailpit
```

API: <http://localhost:3208/api/v1> · Docs: <http://localhost:3208/docs> · Verification emails: <http://localhost:8025>

Without Docker: start PostgreSQL, MongoDB and Redis, then `npm ci && npx prisma migrate deploy && npm run dev` and, in a second terminal, `npm run worker`.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | API with reload |
| `npm run build` / `npm start` | Compile and run the API |
| `npm run worker` | Queue worker (settles transactions) |
| `npm test` | Whole suite (in-memory) |
| `npm run typecheck` | Strict type check |

The PostgreSQL suite runs against a real database when `TEST_DATABASE_URL` points at an empty, migrated test database (skipped otherwise). The Redis rate-limit suite starts its own `redis-server` and needs it installed.

## Layout

```
src/
  config/        validated environment
  errors/        AppError and named subclasses
  domain/        entities, pricing rules (pure)
  repositories/  interfaces + memory / postgres / mongo implementations, UnitOfWork
  integrations/  prisma, mongo, redis, mailer, queue (third-party main files)
  rateLimit/     5 algorithms, memory + Redis (Lua), named policies
  services/      business logic (ledger, transfers, bills, settlement, command centre ...)
  routes/        one folder per feature: schema, controller, routes
  middleware/    auth, validation, rate limiting, errors
prisma/          schema and migrations
docs/            OpenAPI, corporate guide
tests/           unit and integration
```

## Key design decisions

* **Money is integer kobo** everywhere; conversion happens only for display.
* **Debit now, settle later.** A request debits the sender in one database transaction and queues a BullMQ job; the worker credits the recipient or calls the provider and refunds permanent failures. Responses are `202` and fast.
* **Optimistic locking** on accounts (`version`) with bounded, jittered retries, and compare-and-swap on transaction status so settlement is idempotent.
* **Idempotency-Key** per profile prevents double charges.
* **Rate limiting** is configuration-only: `RATE_LIMIT_ALGORITHM` and `RATE_LIMIT_STORE`; policies, costs and fail-open/closed behaviour are in `src/rateLimit/rateLimit.policies.ts`.
* **Command Centre** switches features and providers on or off at runtime (`/command-centre/states`).

## Known limitations

* All providers, BVN lookups and phone codes are **mocks** (see `src/providers/mock`).
* `prisma/migrations` was written by hand; verify with `prisma migrate diff` before first production use.
* A transaction whose provider keeps failing transiently after all retries stays `PROCESSING` and needs reconciliation.
