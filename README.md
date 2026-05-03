# B2B Contractor Marketplace MVP

A clean, extensible marketplace MVP for facilities-management customers and subcontractor suppliers. Built with Next.js App Router, TypeScript, Prisma, SQLite-by-default local development, Tailwind CSS, Zod validation, bcrypt password hashing, and a payment service layer designed for later Stripe Connect integration.

## Project structure

- `src/app` - App Router pages and protected API routes.
- `src/components` - Small reusable UI primitives.
- `src/lib` - configuration, auth/session, RBAC, validation, money formatting, dashboard queries.
- `src/services` - business services for jobs, wallets, fees, notifications, and payment providers.
- `prisma/schema.prisma` - relational data model.
- `prisma/seed.ts` - demo seed data.
- `src/services/__tests__` - workflow and service tests.

## Setup

```bash
cp .env.example .env
npm install
npm run db:generate
npm run db:push
npm run db:seed
npm run dev
```

Open `http://localhost:3000`.

Required environment variables:

```bash
DATABASE_URL="file:./dev.db"
AUTH_SECRET="replace-with-a-long-random-secret-at-least-32-chars"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
AUTO_RELEASE_HOURS="48"
PAYMENT_PROVIDER="mock"
```

## Test commands

```bash
npm run typecheck
npm run lint
npm test
```

## Demo accounts

Seeded users use password `Password123!`.

- Admin: `admin@example.com`
- Customers: `fm.customer@example.com`, `ops.customer@example.com`
- Approved suppliers: `plumbing.supplier@example.com`, `electrical.supplier@example.com`
- Pending supplier: `cleaning.supplier@example.com`

## Demo workflow

1. Customer logs in, adds simulated wallet funds, and posts either a bidding or broadcast job.
2. Broadcast jobs notify matching approved suppliers by service and location. If `firstSupplierCanAccept` is enabled, the first approved supplier can accept instantly.
3. Suppliers browse open jobs and either submit offers or accept eligible broadcast jobs.
4. Customer accepts an offer. The wallet service reserves the customer total, including the 10% customer fee.
5. Supplier starts and completes the job with completion notes and optional photo URLs.
6. Funds move from customer reserved balance to supplier pending balance, while platform fee transactions are recorded.
7. Customer approves, disputes, or the admin-triggered auto-release route closes due jobs after `AUTO_RELEASE_HOURS`.
8. Approved funds move to supplier available balance and can be withdrawn in a simulated transaction.

Job statuses follow the operational lifecycle: `OPEN` -> `ASSIGNED` -> `IN_PROGRESS` -> `AWAITING_APPROVAL` -> `CLOSED`, with `CANCELLED` and `DISPUTED` exception paths. Completion evidence is stored while the job is awaiting customer approval.

## Payment simulation

Payments are architecture-first, not real money movement. `PaymentProvider` defines:

- `createPayment()`
- `releasePayment()`
- `refundPayment()`

`MockPaymentProvider` returns deterministic mock provider references. `StripePaymentProvider` is intentionally a placeholder with the same interface, so Stripe Connect can later be wired into wallet funding, escrow reservation, transfer release, refunds, and withdrawals without rewriting job workflows.

## Fee model

Centralized in `src/services/fee-service.ts`:

- Customer fee: 10%
- Supplier fee: GBP 1 flat
- Example GBP 100 job: customer pays GBP 110, supplier receives GBP 99, platform earns GBP 11.

All money is stored as integer pence.

## Security and access control

- Email/password authentication with bcrypt hashes.
- JWT session stored in an HTTP-only cookie.
- Zod validation on request payloads.
- Middleware protects role-specific dashboard and API route prefixes.
- Route handlers call `requireUser()` and service methods enforce workflow invariants.
- Supplier accounts default to pending and need admin approval before accepting jobs or submitting offers.

## Production gaps

- Real Stripe Connect onboarding, transfers, webhooks, refunds, and reconciliation.
- PostgreSQL deployment migrations and operational backups.
- Email/SMS/push notifications beyond the current in-app notifications.
- Background job runner for auto-release instead of the admin-triggered endpoint.
- Audit logging, dispute-resolution tooling, KYC/AML, tax, invoicing, GDPR/data-retention, and insurance/compliance workflows.
- More robust search/geography and supplier availability matching.
