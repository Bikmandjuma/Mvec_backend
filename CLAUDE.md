# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The Ikiguzi (MVEC) marketplace API: Express 5 on MySQL/MariaDB. The website (`../Mvec_frontend`) and the Flutter app (`../Mvec_Mobile`) call it under `/api`. People see the name **Ikiguzi**; "MVEC" survives only in code, folder names and stored values (for example `gatewayFeePayer: "MVEC"`, `MVEC-PRD-…` ids). Never rename stored values.

## Commands

```bash
npm run dev                 # nodemon on :4000 (refuses to start without a reachable, migrated database)
npm run db:migrate          # create/update every table
npm run db:seed             # demo admin, sellers, buyer, catalog (refused on a live server)
npm test                    # every test, one file at a time, against DB_DATABASE + "_test"
node --require ./tests/helpers/env.js --test tests/integration/rider.delivery.test.js   # one file
npm run test:e2e            # flows against a running server
```

Tests need MySQL. `tests/helpers/mysql.js` creates and migrates the `_test` database and empties it between tests. Run files one at a time, because they share one database. `tests/financial.controller.test.js` has a 50 ms benchmark that fails on a busy machine.

## Development or live (`src/config/env.js`)

- `isLive()` is the only switch. Only `NODE_ENV=development` or `test` is a development server. Anything else, including no `NODE_ENV`, is live. Never compare `NODE_ENV` to `"production"`.
- On a live server, `startupReport()` refuses to start with unsafe settings: a weak `JWT_SECRET`, no database password, a localhost `FRONTEND_URL`, example webhook secrets or admin password, or no SMS gateway while `SHOW_RIDER_CODES=false`. A development server only warns.
- A live server never simulates payments, never prints SMS codes, and never accepts unsigned webhooks.
- The one exception, until SMS works: riders (sign-up and sign-in only) see their code on screen when no text can be sent. It is on by default, live servers included (`showRiderCodes()` in `config/env.js`). `SHOW_RIDER_CODES=false` turns it off. Keep it on until the owner says otherwise.
- Requiring `src/config/env.js` loads `.env`, so `server.js` requires it first.

## Data layer

- Models in `src/models/*` are Mongoose-style wrappers (`src/database/mongoose-compat`) over Sequelize.
- Users, stores, products and similar tables are hand-written in `src/database/models/`. Every other table is a spec in `src/database/spec/` (`commerce.js`, `platform.js`, `delivery.js`).
- A new field needs a migration in `src/database/migrations/` plus the spec. Hand-written models also need their `mongoose-compat/registry.js` entry.
- `updateOne` / `findOneAndUpdate` re-check the filter inside the UPDATE. Use a conditional update for anything two people can race on, as in "first rider to accept wins" and the code-attempt counters.
- Ids are 24-character hex strings.

## Sellers before approval (`services/listingApproval.service.js`)

- Vendors and suppliers can do everything from sign-up: add products, stock, stores and prices. Buyers see their products only once an admin sets the seller's `verificationStatus` to VERIFIED.
- Until then, a product meant to go live is stored as `PENDING_APPROVAL`, which no buyer-facing query shows (they all read `ACTIVE`/`OUT_OF_STOCK`). Create, update and supplier publish apply `statusFor()`. Stock changes never move a waiting product to `OUT_OF_STOCK`.
- The admin's verify decision calls `followDecision()`. VERIFIED puts waiting products live, and REJECTED takes live ones back to waiting. Drafts and hidden products stay as the seller left them.

## Money

- The buyer pays Ikiguzi, and the money sits in escrow. `services/payment.service.js` locks one settlement per order item, plus one commission-free settlement per parcel's delivery fee.
- `services/handover.service.js` is the only place a seller's money is released after delivery. Sellers, admins (`PATCH /orders/:id/deliver`) and riders all go through it, each with the buyer's 6-digit `deliveryOtp`, which locks after 5 wrong tries.
- An order becomes DELIVERED once every seller in it has handed over.
- When a rider carried a parcel, its fee settlement moves to the rider's wallet (`VendorWallet` keyed by user id) before it is released.
- `financial.service.js` keeps the double-entry ledger. Never update wallets or settlements anywhere else.

## Ikiguzi riders (`services/delivery.service.js`, `config/delivery.js`)

This is KitchenLink's delivery-worker model, with one job per seller parcel.

**Setup**
- A store sets a pickup pin and `riderDelivery`. Buyers send `shippingAddress.lat/lng`.
- `shipping.service.quoteShipping` prices that store's parcel by distance, with `method: "RIDER"`. Without pins, or beyond 30 km, the seller's own zones apply.
- Free-delivery coupons never cover rider parcels.

**A job's life**
- Early dispatch, as in KitchenLink: when the buyer pays, `orderPaid` creates a `Delivery` for each rider parcel with `readyAt: null` and offers it straight away, so a rider can head over while the seller prepares it. When the seller marks its part READY_FOR_SHIPMENT, `createForOrder` sets `readyAt` (`markReady`), or creates the job if none exists (cash on delivery, older orders).
- A rider who accepted early follows the seller's steps. `sellerStepped` tells them about each one, and `markReady` tells them to collect, by SMS too. `serialize` returns `ready`, `waitingForSeller` and `progress`, a timeline from order placed to delivered. Picking up is refused until `readyAt` (`PARCEL_NOT_READY`). The late-pickup clock counts from the later of accepting and ready.
- Before pickup a rider can hand a parcel back (`POST /api/rider/deliveries/:id/release`). A seller's parcel can take hours to be ready, so a rider is never stuck holding one.
- Offers go to approved, online riders with a fresh position within the radius, nearest first.
- First to accept wins. A decline is never offered to that rider again, and unanswered offers re-dispatch every minute (`workers/slaWorker.js`).
- Steps are ASSIGNED → PICKED_UP → OUT_FOR_DELIVERY, then `confirm` with the buyer's code.
- Sellers can't move a rider parcel to shipped or out for delivery. The order follows the rider.
- Going offline hands parcels not yet picked up back to the pool.
- Late pickup (`checkLatePickups`, every minute): `DELIVERY_PICKUP_MINUTES` after accepting, the rider is reminded `DELIVERY_PICKUP_WARN_MINUTES` before, flagged at the deadline (rider and admins told), and the parcel goes to another rider `DELIVERY_PICKUP_REASSIGN_MINUTES` after it. Admins can hand a parcel back sooner (`POST /api/admin/deliveries/:id/release`).

**Live tracking (`services/tracking.service.js`)**
- Each GPS fix (`PATCH /api/rider/location`) can carry heading, speed and accuracy.
- `GET /api/orders/:id/live` shows the rider, road route, distance and ETA to the buyer, the seller (its own parcels) and admins. `GET /api/rider/deliveries/:id/navigation` adds turn-by-turn steps. `GET /api/admin/deliveries` lists every parcel on the way.
- Routes come from OSRM (`OSRM_URL`, OpenStreetMap roads, about one call a second, cached), and fall back to straight lines when it's empty or down. Tests set it empty.

**Accounts**
- Riders sign up with a phone code: `POST /auth/send-otp` → `POST /auth/verify-otp` with `role: "delivery"` → `POST /api/rider/register`. The website (`/signup`, "Delivery worker") and the app (`/rider`) both use this. Riders have no usable password and sign in with a phone code (`purpose: "login"`). Google sign-up never creates riders.
- Self sign-ups wait for admin approval (`/api/admin/riders`). An admin's "Add courier" creates an approved rider.
- Before accepting, a rider sees only the pickup area and fee. The buyer's name, phone and pin appear once the job is theirs.

## Conventions

- Errors are `{ message }` in plain words people can act on (`middleware/friendlyErrors.js` adds a support reference to 5xx errors).
- Throw `Object.assign(new Error(msg), { statusCode })` from services. Controllers send `error.statusCode || 500`.
- Uploads (`routes/upload.routes.js`) go through multer. Each file's first bytes must match its declared image type, and `utils/imageMetadata.js` strips its EXIF data, GPS included, before saving.
- Admin changes are written to the audit log by `middleware/adminAudit.js`. Add a line there for each new admin endpoint.
