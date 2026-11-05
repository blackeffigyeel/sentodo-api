# Sentodo MFB: Corporate API guide

This guide is for companies that use the Sentodo API to buy airtime, data, electricity, education PINs, TV subscriptions and food, and to send money (to Sentodo accounts and to other Nigerian banks) on behalf of their own customers or staff.

The full reference is the interactive OpenAPI documentation at `/docs` (raw spec at `/docs/openapi.json`). This guide explains how the pieces fit together.

## 1. Concepts

| Term | Meaning |
|------|---------|
| **Profile** | A user of the platform. A company has a **corporate profile**. |
| **Account** | A 10-digit Sentodo account number that belongs to a profile. A profile can hold up to 5. |
| **Kobo** | All money is an **integer number of kobo** (1 NGN = 100 kobo). `250000` is ₦2,500.00. Never send decimals or strings. |
| **Transaction** | One money movement. Status moves from `PROCESSING` to `SUCCESS` or `FAILED`. |

Corporate profiles get a **2.5% discount** on bill payments (individuals get 1%) and **10 free transfers per month** (individuals get 20). After the free allowance, a transfer costs ₦10 plus 7.5% VAT, with a further ₦50 (before VAT) on transfers above ₦10,000.

### Response envelope

Every response, success or error, looks like this:

```json
{ "success": true, "message": "Account retrieved", "data": { } }
```

On errors `success` is `false`, `message` explains what happened and `data` is `null` or carries safe detail (for example the validation `issues`, or `{ "retryAfterSeconds": 2 }`).

## 2. Onboarding

1. **Register** a corporate profile: `POST /auth/register` with `"type": "CORPORATE"`, `email`, `phone` (11 digits), `password` and `businessName`.
2. **Verify email** with the 6-digit code emailed to you: `POST /auth/verify-email`.
3. **Verify phone**: `POST /auth/verify-phone`. In this environment no SMS is sent; use one of the configured test codes (default `123456`).
4. When both are verified, your first **account number** is created automatically (`GET /accounts`).
5. **Sign in**: `POST /auth/login` returns a bearer token (valid for one hour by default).
6. **Verify identity**: `POST /profiles/me/identity` with a BVN. **No money can leave an account until this is done.**

## 3. API keys and IP allowlisting

Integrations authenticate with an **API key** sent in the `x-api-key` header. Keys are managed with your signed-in **bearer token** (a key cannot create or change keys).

```bash
# Create a key. Allowlist the public IP addresses of your servers.
curl -X POST https://api.example.com/api/v1/api-keys \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "name": "Production", "allowedIps": ["41.58.1.9", "102.89.0.4"] }'
```

```json
{
  "success": true,
  "message": "API key created. Copy it now: it will not be shown again.",
  "data": {
    "apiKey": { "id": "…", "name": "Production", "prefix": "sk_live_9f2c", "allowedIps": ["41.58.1.9", "102.89.0.4"], "status": "ACTIVE" },
    "key": "sk_live_9f2c…"
  }
}
```

* **The raw key is shown once.** Sentodo stores only a hash; if you lose it, create a new key and revoke the old one.
* **A key only works from allowlisted IPs** (IPv4 or IPv6, exact addresses; ranges are not supported). Requests from any other address get `403`.
* At least one IP is required. Change it any time with `PATCH /api-keys/{id}/allowlist` (the key stays the same).
* Revoke with `DELETE /api-keys/{id}`. Revocation is permanent. You can have up to 10 active keys, so rotate by creating the new key first.
* Keep keys on your servers. Never put them in mobile apps or browsers.

Use the key like this:

```bash
curl https://api.example.com/api/v1/accounts -H "x-api-key: $SENTODO_KEY"
```

## 4. Making money-moving calls safely

### Idempotency (always send it)

Networks fail. If a request times out you cannot know whether it was processed. Send an `Idempotency-Key` header (8 to 64 characters: letters, digits, `-`, `_`) that is **unique per logical operation**, and reuse the same value when you retry. Sentodo returns the original transaction instead of charging twice.

```bash
curl -X POST https://api.example.com/api/v1/bills/airtime \
  -H "x-api-key: $SENTODO_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: payout-2026-11-05-000123" \
  -d '{ "fromAccountId": "7b1f6c0e-…", "network": "MTN", "phone": "08031234567", "amount": 100000 }'
```

Good keys come from your own records, such as your order id. A retry with a different request body but the same key returns the first transaction, so do not reuse keys across different orders.

### Asynchronous processing

Transfers and purchases return **`202 Accepted`** straight away. Your account has already been debited (amount minus any discount, plus any fee) and the transaction is `PROCESSING`. A background queue completes it.

```
POST /transfers or /bills/*  →  202  status: PROCESSING
GET  /transactions/{id}      →  200  status: SUCCESS | FAILED
```

* Poll `GET /transactions/{id}` (you can also use the `reference`) every few seconds, with backoff.
* `SUCCESS`: done. For electricity, education and food, `details.token` holds the meter token, PIN or order code.
* `FAILED`: the provider declined. **The full amount, including any fee, has already been refunded**, and `failureReason` explains why.
* Treat `PROCESSING` as "not final yet". Do not retry with a new idempotency key while a transaction is still `PROCESSING`.

## 5. Common flows

### Send money

1. (Optional) Name enquiry: `GET /banks/resolve?bankCode=058&accountNumber=0123456789` returns the account holder's name. Show it to your user before sending.
2. (Optional) `POST /transfers/quote` shows the fee and the total debit.
3. `POST /transfers` with `fromAccountId`, `bankCode`, `accountNumber`, `amount` (kobo) and an `Idempotency-Key`.

If the recipient is a Sentodo account (`bankCode` `090`) the transfer is treated as **p2p**. Minimum ₦1.00, maximum ₦5,000,000.00 per transfer. Bank codes come from `GET /banks`.

### Buy a bill

| Category | Endpoint | Notes |
|----------|----------|-------|
| Airtime | `POST /bills/airtime` | ₦50 to ₦50,000; networks MTN, AIRTEL, GLO, 9MOBILE |
| Data | `POST /bills/data` | Choose `planCode` from `GET /bills/catalogue/data`. Catalogue price always applies |
| Electricity | `POST /bills/electricity` | 11 to 13 digit meter number, `PREPAID` or `POSTPAID`, ₦500 to ₦200,000 |
| Education | `POST /bills/education` | WAEC, NECO, JAMB PINs |
| TV | `POST /bills/tv` | DStv and GOtv. 10-digit IUC number. Validate first (below) |
| Food | `POST /bills/food` | Items from `GET /bills/catalogue/food`, plus a delivery fee |

`POST /bills/quote` prices any bill without charging.

### Validate a TV smart card

Only TV supports customer validation. Show the customer name before charging:

```bash
curl -X POST https://api.example.com/api/v1/bills/tv/validate \
  -H "x-api-key: $SENTODO_KEY" -H "Content-Type: application/json" \
  -d '{ "operator": "DSTV", "iuc": "7012345678" }'
# → { "success": true, "data": { "operator": "DSTV", "iuc": "7012345678", "customerName": "OKONKWO ADAEZE C" } }
```

An unknown card returns `404`; an IUC that is not exactly 10 digits returns `400`. A purchase for an unknown card is rejected without charging you.

## 6. Errors

| Status | Meaning | What to do |
|--------|---------|-----------|
| `400` | Invalid request. `data.issues` lists each problem | Fix the request. Do not retry unchanged |
| `401` | Missing, invalid or revoked credentials | Check the key or token |
| `403` | Not allowed: identity not verified, IP not allowlisted (`data.ip` shows the address Sentodo saw), profile suspended | Fix the cause; check your egress IP |
| `404` | Not found (also used for accounts and transactions that are not yours) | Check ids |
| `409` | Conflict, for example a duplicate registration | Usually do not retry |
| `422` | Valid request that cannot be processed, for example insufficient funds (`data.balance` in kobo) | Top up, then retry |
| `429` | Rate limited. Honour the `Retry-After` header (seconds) | Wait, then retry |
| `502`/`503` | A provider or feature is temporarily off, or Sentodo cannot process right now | Retry with backoff using the **same** `Idempotency-Key` |

A `503` on a purchase means you were **not charged**.

## 7. Rate limits

Limits are applied **per API key**, so one noisy key does not affect another. Responses carry `X-RateLimit-Limit` and `X-RateLimit-Remaining`. When you receive `429`, wait for `Retry-After` seconds. Transfers and purchases use more of your allowance than reads. Use exponential backoff with jitter on retries, and avoid tight polling loops.

## 8. Checking service status

`GET /command-centre/states` (works with your API key) lists every feature and provider and whether it is currently on, with a reason when it is off. Check it before sending traffic during incidents, or surface it in your own status page. For example, if `bills.tv` or the provider `mock-tv-dstv` is off, purchases for it return `503`.

## 9. Testing in this environment

* All providers are simulated. A **customer number or account number ending in `0000` is declined** by the provider (the transaction becomes `FAILED` and is refunded). An account number ending in `9999` cannot be resolved.
* Test smart cards: DStv `7012345678`, `7023456789`, `7034567890`; GOtv `4012345678`, `4023456789`.
* Test BVNs (individuals must match the name): `22222222221` Adaeze Okonkwo, `22222222222` Tunde Bakare, `22222222223` Fatima Bello, `22222222224` Chinedu Eze, `22222222225` Ngozi Adeyemi. Corporate profiles accept any listed BVN.
* Test money: if an operator has switched on **sandbox funding**, `POST /accounts/{id}/fund` credits test money (up to ₦1,000,000 at a time).

## 10. Checklist before going live

- [ ] Idempotency keys on every transfer and purchase, derived from your own order ids
- [ ] Retry only `429`, `502` and `503`, with backoff and the same key
- [ ] Poll transactions to a final status; handle `FAILED` as already refunded
- [ ] API keys stored as secrets, with the narrowest possible IP allowlist
- [ ] Separate keys per environment and per service, and a rotation routine
- [ ] Name enquiry shown to users before sending money, and TV validation before TV purchases
