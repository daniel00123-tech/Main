# Contractor Marketplace MVP

A clean, extensible MVP for a B2B contractor marketplace where facilities management customers post jobs and approved subcontractors bid on or accept work. Payments are simulated through a service layer designed for a future Stripe Connect integration.

## Stack

- Next.js App Router + TypeScript
- Prisma ORM
- SQLite for local development, with PostgreSQL-ready schema conventions
- NextAuth credentials auth
- bcrypt password hashing
- Zod validation
- Tailwind CSS
- Vitest service tests

## Project structure

```txt
prisma/
  schema.prisma            Database models, enums, relationships
  migrations/              Initial schema migration
  seed.ts                  Demo data and completed transaction workflow
src/
  app/                     Next.js routes, dashboards, API routes, server actions
  components/              Shared UI building blocks
  lib/                     Auth, Prisma, config, validation, money helpers
  services/                Domain services for jobs, users, fees, wallets, payments
  services/payment/        Provider interface, mock provider, Stripe placeholder
```

## Required environment variables

Copy `.env.example` to `.env` and update values as needed:

```bash
DATABASE_URL="file:./dev.db"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="replace-with-a-long-random-secret"
PAYMENT_PROVIDER="mock"
JOB_AUTO_RELEASE_HOURS="24"
```

No real payment secrets are required for the MVP.

## Setup

```bash
npm install
npx prisma migrate dev
npm run prisma:seed
npm run dev
```

Open `http://localhost:3000`.

Seeded logins all use password `password123`:

- Admin: `admin@example.com`
- Customer: `customer1@example.com`
- Customer: `customer2@example.com`
- Approved supplier: `supplier1@example.com`
- Approved supplier: `supplier2@example.com`
- Pending supplier: `supplier3@example.com`

## Tests and checks

```bash
npm test
npm run lint
npm run build
```

The test suite covers registration, supplier approval, job posting, offer submission, job assignment, fee calculation, wallet updates, broadcast assignment, withdrawals, and payment release simulation.

## Demo workflow

1. Log in as a customer and add simulated wallet funds.
2. Post a bidding job or a broadcast job.
3. For bidding jobs, log in as an approved supplier and submit an offer.
4. Log back in as the customer and accept the offer. Funds are reserved from the customer wallet, including the 10% customer fee.
5. Log in as the supplier, start the job, and mark it complete with notes and optional photo URLs.
6. Supplier funds move to pending balance.
7. Log in as the customer and approve completion. Funds are released to the supplier's available balance.
8. The platform records fees: for a £100 job, customer pays £110, supplier receives £99, and platform earns £11.

Broadcast jobs with `autoAssign` enabled notify matching approved suppliers and the first supplier to accept is assigned.

## Payment simulation

Payments are intentionally not real. The payment architecture is split into:

- `PaymentProvider` interface
- `MockPaymentProvider`, used by default
- `StripePaymentProvider`, a placeholder that marks the future integration boundary
- `PaymentService`, which records marketplace transactions through Prisma

Wallet behavior:

- Customers add simulated funds.
- Assignment reserves customer funds.
- Completion moves supplier earnings to pending balance.
- Customer approval or auto-release moves pending funds to supplier available balance.
- Supplier withdrawals are simulated.

## How Stripe plugs in later

Stripe Connect can be added by implementing `StripePaymentProvider` with:

- Customer payment intent creation
- Connected account onboarding
- Transfer or destination charge release
- Refund and dispute handling
- Webhook-driven transaction reconciliation

The job and wallet services already depend on the payment provider interface rather than direct Stripe calls.

## What is missing before production

- Real Stripe Connect integration and webhook reconciliation
- Hosted PostgreSQL with backups, migrations, and observability
- Email/SMS notifications in addition to in-app notifications
- Stronger dispute, refund, and moderation workflows
- File upload/storage for completion photos
- Audit logs and admin permission granularity
- Legal, tax, KYC/KYB, GDPR, and financial compliance review
- Rate limiting, CSRF hardening for custom forms, and production secret management
