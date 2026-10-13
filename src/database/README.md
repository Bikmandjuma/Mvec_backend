# Database (MySQL / MariaDB)

All application data lives in MySQL (MySQL 8 or MariaDB 10.4+, e.g. XAMPP). MongoDB is
no longer used; it is only read once by the data-copy script below.

## Setup

`.env`:

```
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=ikiguzi
DB_USERNAME=root
DB_PASSWORD=             # quote it if it contains # or spaces
```

1. Create the database once (XAMPP: phpMyAdmin → SQL, or the `mysql` client):
   `CREATE DATABASE ikiguzi CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
2. `npm run db:migrate` – creates/updates every table.
3. Optional: `npm run db:seed` for demo accounts and catalog, or copy old data (below).
4. `npm run dev` – the server checks the connection and that every migration is applied
   before it starts listening, and prints what to do if not (start MySQL, create the
   database, run migrations, fix credentials).

`GET /health` reports `{ db: "up" | "down" }`.

## How it works

- **Tables** – Sequelize migrations in `migrations/`. Users, vendors, stores, staff,
  categories, products and stock movements have hand-written models in `models/`; every
  other table is declared once as a spec in `spec/` (`commerce.js`, `platform.js`) and built
  by `spec/define.js`.
- **Models** – each `src/models/*.js` exports a model from `mongoose-compat/`, which gives
  controllers a familiar document API (`find/findOne/findById` with `populate/sort/select/
  limit/skip/lean`, `save()`, `create`, `findOneAndUpdate` with `$set $inc $push $pull
  $addToSet`, `updateMany`, `deleteMany`, `countDocuments`, `distinct`, `aggregate`) and runs
  it as SQL through Sequelize.
- **Ids and transactions** – `src/database/orm.js` provides `isValidObjectId`,
  `Types.ObjectId` and `startSession()`. Ids are 24-character hex strings (CHAR(24) primary
  keys). `startSession()` + `startTransaction()` is a MySQL transaction; it opens its
  connection on the first query and is rolled back automatically if it is ever left open.
- **Data shapes** – dates are `DATETIME(3)` in UTC; embedded lists are child tables
  (`order_items`, `cart_items`, `user_wishlist_items`, …); nested objects are flattened
  columns; free-form values are `JSON` (MariaDB stores them as text; they are parsed on read).

## Commands

| Command | What it does |
|---|---|
| `npm run db:migrate` | Create / update tables |
| `npm run db:migrate:status` | Applied and pending migrations |
| `npm run db:migrate:undo` | Roll back the last migration |
| `npm run db:seed` / `db:seed:undo` | Demo vendors, stores, staff, buyer and catalog (refused in production unless `SEED_ALLOW_PRODUCTION=true`) |
| `npm run db:copy-from-mongo` | One-time copy of old MongoDB data (`MONGO_URI`) into MySQL; read-only on MongoDB, re-runnable |
| `npm test` | Unit + integration tests on `<DB_DATABASE>_test` (created and migrated automatically) |
| `npm run test:e2e` | 163 API steps against a throwaway `ikiguzi_e2e_test` database |

Tests refuse to run against a database whose name does not end in `_test`, never call real
payment providers and never send real email or SMS.

## Migrations

Migrations only add tables/columns/indexes, widen enums and relax NOT NULL; none drops data.
Each has a `down` that removes what it added. Recent ones:

- `20261013000100-ikiguzi-buyer-affiliate-supplier` – order recipient/courier/disputes,
  affiliate attribution and reversals, refunds & withdrawals, wishlists, onboarding,
  staff invitations, supplier reviews/supply requests/team.
- `20261013000200-card-payments` – card payments (Flutterwave) and card refunds.
- `20261013000300-paid-subscriptions` – payments record what they buy (buyer Premium).

## Differences from the old MongoDB behaviour

- Text equality and unique indexes are case-insensitive (`utf8mb4_unicode_ci`).
- A field that was never set comes back as `null` instead of being absent.
- Aggregations run their first `$match` in SQL and the remaining stages in Node; fine at
  dashboard sizes, move hot ones to SQL if they grow large.
