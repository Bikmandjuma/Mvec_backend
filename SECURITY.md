# Security and going live

Read this before deploying, and before changing sign-in, uploads, payments or delivery code.

## Development vs live

The server is a **development server only when `.env` says `NODE_ENV=development` or `NODE_ENV=test`**. Anything else, including a missing `NODE_ENV`, is live (`src/config/env.js`).

| | Development | Live |
| --- | --- | --- |
| Unsafe settings (below) | Listed as warnings, server starts | **Server refuses to start** and lists them all |
| Payments without a gateway | Simulated | Refused ("temporarily unavailable") |
| Sign-in codes without an SMS gateway | Written to the server log | Never written anywhere |
| Unsigned payment webhooks (`ALLOW_UNSIGNED_WEBHOOKS=true`) | Accepted | Ignored |
| Demo seeders | Allowed | Refused unless `SEED_ALLOW_PRODUCTION=true` |

## Required on a live server

| Setting | Requirement |
| --- | --- |
| `JWT_SECRET` | Random, 32+ characters: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Changing it signs everyone out. |
| `DB_PASSWORD` | Set. Keep MySQL off the internet. |
| `FRONTEND_URL` | The website's public address (email links and CORS). |
| `MOMO_WEBHOOK_SECRET`, `AIRTEL_WEBHOOK_SECRET`, `PAYPACK_WEBHOOK_SECRET` | The real secrets from each provider, never the example values. |
| `ADMIN_PASSWORD` | 12+ characters, not the example. |
| `SMS_PROVIDER` | `pindo` with `PINDO_API_TOKEN`, or `africastalking` with `AT_USERNAME` and `AT_API_KEY`. `SMS_FROM_NAME` must be the sender name registered with that provider. |

Optional, and the server warns when they're missing:
- a payment gateway (`MOMO_BASE_URL`, `AIRTEL_GATEWAY_BASE_URL`, Paypack, Flutterwave or KPay keys)
- email (`EMAIL_USER`, `EMAIL_PASS`)

Behind a load balancer, set `TRUST_PROXY=1` so rate limits see real client addresses.

## What protects what

**Payment callbacks**
- They mark orders paid, so each one must carry a valid HMAC signature (`utils/webhookAuth.js`).
- Processing is idempotent per provider transaction.

**Delivery codes**
- The buyer's 6-digit code releases the seller's money.
- Wrong tries are counted atomically and lock after 5, after which Ikiguzi support confirms by hand.
- Sellers never see the code, and riders only type it in.

**Riders**
- They work only once an admin approves them.
- An offer shows only the pickup area and the fee. The buyer's name, phone and exact pin are revealed to the rider who accepted.
- A rider's position is accepted only inside Rwanda.

**Uploads**
- Images only, with their first bytes checked against the declared type, 8 MB each (3 MB for profile photos).
- Metadata is stripped before saving, so a phone photo's GPS location never goes public.
- Files are public at `/uploads/<random name>`, so never accept identity documents through this route.

**Rate limits** (`middleware/rateLimits.js`) apply to sign-in, sign-up, codes, payments, orders and rider registration. They're off only in tests.

**Admin actions** are written to the audit log (`middleware/adminAudit.js`).
