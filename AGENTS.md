# AGENTS.md

## Repository structure

This repository hosts **two independent products** on separate feature branches (the `main` branch is essentially empty):

| Branch | Product | Stack |
|--------|---------|-------|
| `cursor/bigchange-completed-jobs-bot-ca98` | BigChange Completed Job Actioner (Python CLI) | Python ≥3.11, requests, pytest |
| `cursor/contractor-marketplace-mvp-d1c4` | B2B Contractor Marketplace MVP | Next.js 16, Prisma 6, SQLite, Tailwind, Vitest |

## Cursor Cloud specific instructions

### General notes

- Node.js 20 LTS is required for the Marketplace. It is installed via the NodeSource apt repo.
- Python 3.12 is available system-wide; the BigChange project uses a virtualenv at `.venv`.
- Git worktrees are recommended for working with both products simultaneously (e.g. `/workspace/worktrees/bigchange` and `/workspace/worktrees/marketplace`).

### BigChange Actioner (Python)

```bash
# From the bigchange worktree/branch checkout:
python3 -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"
pytest -v
```

- Tests use `responses` (HTTP mocking); no external BigChange API credentials are required for tests.
- The CLI entrypoint is `bigchange-actioner` once installed.

### Contractor Marketplace (Node.js / Next.js)

```bash
# From the marketplace worktree/branch checkout:
cp .env.example .env   # only needed on first setup
npm install
npx prisma generate
npx prisma db push
npx tsx prisma/seed.ts
npm run dev
```

- **Prisma version**: Use Prisma 6 (`prisma@6` / `@prisma/client@6`). The schema uses the v5/v6 `datasource url` syntax which is removed in Prisma 7.
- **Database**: SQLite file at `prisma/dev.db`. No external DB server needed.
- **Schema fix**: The `CustomerProfile` model originally referenced a non-existent `walletId` field. This has been removed (wallet is accessed through the user). The `isRole` type guard was also missing from `src/lib/types.ts` and needed to be added.
- **Seeded accounts** (all use password `Password123!`):
  - `admin@example.com` — Admin
  - `fm.customer@example.com` — Customer (Alex Morgan, Northstar FM)
  - `ops.customer@example.com` — Customer (Priya Shah, Metro Facilities)
  - `plumbing.supplier@example.com` — Approved Supplier
  - `electrical.supplier@example.com` — Approved Supplier
  - `cleaning.supplier@example.com` — Pending Supplier

**Key scripts** (see `package.json` for all):
- `npm run dev` — Start dev server (port 3000)
- `npm run build` — Production build (runs `prisma generate` + `next build`)
- `npm run lint` — ESLint
- `npm run typecheck` — TypeScript strict check
- `npm run test` — Vitest
- `npm run db:seed` — Re-seed database

### Known issues

- The `package.json` uses `"latest"` for all dependency versions. Pin Prisma to v6 to avoid breaking changes from v7+.
- TypeScript errors existed in the original branch around string/union type mismatches with job status arrays (fixed with `as string[]` casts) and the missing `isRole` function.
