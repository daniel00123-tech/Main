# INFRA Pilot UAT Guide

Internal runbook for onboarding a small pilot company. Stripe remains in **test mode**; auto top-up **execution** stays disabled unless explicitly enabled by platform operators.

## Create a pilot company

1. Sign in to **Platform Admin** → **Companies** → **Add company**.
2. Set name, slug, timezone, and billing mode **test**.
3. Open the company **Control Centre** and confirm onboarding checklist items.

## Invite users

1. Platform Admin or company admin → **Users** (portal) or Control Centre **Users** tab.
2. **Invite user** with email, display name, and role.
3. If email delivery is not configured (`RESEND_API_KEY`), copy the **setup link** from the invitation row and send it manually.
4. Duplicate active invitations for the same email are blocked — resend or cancel the existing invite instead.

## Connect a system (e.g. Xero)

1. Company portal → **Systems** → select connector → follow OAuth/setup.
2. Confirm **System Health** shows connected state (blue = healthy).
3. Read-only regression: contacts, accounts, invoices, P&L — no draft invoices without Action Engine plan flow.

## Connect ChatGPT (AI client)

1. Company portal → **AI Access** → **Connect ChatGPT**.
2. Copy gateway URL and bearer token into ChatGPT custom connector settings.
3. Run **Test connection** from the portal.

## Add test credit

1. Platform Admin → company **Billing** or portal **Billing** → **Add credit** (Stripe test checkout: £10/£25/£50/£100).
2. Or grant **promotional credit** from platform billing tools (internal).
3. Verify wallet balance matches ledger sum on dashboard.

## Test usage

1. Ask ChatGPT a read-only question (e.g. Xero contacts or knowledge search).
2. Portal **Usage** and **Activity** should show human-readable labels.
3. Promotional credit is consumed before paid credit on usage debits.

## Report a fault

1. Note company slug, time (UTC), user email, and what you clicked.
2. Platform Admin → **Failed Requests** or **Usage** export for error codes.
3. Do not share bearer tokens or setup links in tickets.

## Known limitations

- Stripe **live** mode blocked (`STRIPE_LIVE_MODE_ALLOWED=false`).
- Auto top-up **execution** disabled by default (`AUTO_TOPUP_EXECUTION_ENABLED` unset).
- Invitation email requires Resend configuration; manual setup links work without it.
- Direct Xero write tools are blocked; financial writes use Action Engine plan → confirm → execute.
- Disabled users rejected on next API request (no instant JWT revocation).
- Provider cost may show **Unavailable** when not configured — not £0.
