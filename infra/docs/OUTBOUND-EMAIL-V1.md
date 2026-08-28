# INFRA Outbound Transactional Email V1

Reusable, tenant-scoped transactional email for the company portal. Caddington Holdings is the first production tenant.

## Architecture

```
Application route (password reset, invitation, admin test)
        |
        v
sendTransactionalEmail({ companyId, type, recipient, subject, body })
        |
        +-- Sender resolver (approved company sender only)
        +-- Template renderer (@infra/shared)
        +-- Provider adapter
        |       +-- Microsoft Graph sendMail (production)
        |       +-- Resend (development fallback when provider=resend)
        +-- email_outbox delivery record
        +-- audit events (company scoped)
```

Callers never supply a `from` address. The service resolves the approved sender from `company_email_config`.

## Company configuration

Table: `company_email_config`

| Field | Purpose |
|-------|---------|
| `company_id` | Tenant isolation |
| `provider` | `microsoft365` or `resend` |
| `sender_address` | Approved From address |
| `sender_display_name` | Display name |
| `enabled` | Master switch |
| `allowed_types_json` | Allowlisted transactional types |
| `health_status` | `healthy`, `permission_required`, etc. |

Caddington seed (`0033_outbound_transactional_email.sql`):

- Sender: `admin@CaddingtonHoldings.co.uk`
- Display name: Caddington Holdings
- Types: `PASSWORD_RESET`, `USER_INVITATION`, `TEST_EMAIL`

HeatTech, Elvex, and future tenants require their own explicit configuration. They do not inherit Caddington's sender.

## Allowlisted email types (V1)

- `PASSWORD_RESET`
- `USER_INVITATION`
- `TEST_EMAIL` (company admins / platform admins only)

Future types (`AUTOMATION_ALERT`, `CONNECTOR_ALERT`, etc.) are reserved but rejected until activated.

## Microsoft Graph implementation

- Endpoint: `POST /v1.0/users/{senderUPN}/sendMail`
- Permission: **Mail.Send (Application)** — admin consent required
- Uses existing client-credentials token flow (`acquireMicrosoftAppToken`)
- Does **not** add or use Mail.Read
- Handles 401 / 403 / 429 / 5xx with bounded retry

### Sender restriction (Exchange)

Mail.Send (Application) is tenant-wide by default. Restrict outbound sending with **Exchange RBAC for Applications**:

1. Mail-enabled security group: approved sender mailboxes only (includes `admin@CaddingtonHoldings.co.uk`)
2. Assign **Application Mail.Send** to the INFRA app with a management scope limited to that group

See `exchangeMailSendRbacGuide()` in `packages/api/src/services/email/providers/microsoft-graph.ts` for exact steps.

## Password reset flow

1. `POST /api/auth/password-reset/request` with email
2. Rate limit (IP + email bucket)
3. Generic response regardless of account existence
4. Resolve company from portal Origin subdomain + membership, else first company with email config
5. Create hashed single-use token (existing `password_setup_tokens`)
6. `sendTransactionalEmail` with `PASSWORD_RESET` template
7. Audit: `email.password_reset_requested`, `email.send_started`, `email.sent` / `email.failed`

Tokens are never written to audit metadata or delivery records.

## User invitation flow

Existing invitation routes call `queueEmail` → `sendTransactionalEmail` with `USER_INVITATION` when `companyId` is present.

## Rate limiting

Password reset: 8 requests / 15 min per IP, 4 / 15 min per email address. Exceeded limits return the same generic success message.

## Audit / delivery

`email_outbox` stores metadata only (no tokens). Statuses: `sending`, `sent`, `failed`.

Audit events: `email.send_started`, `email.sent`, `email.failed`, `email.password_reset_requested`.

## API endpoints

| Route | Purpose |
|-------|---------|
| `GET /api/companies/:slug/email/config` | Read-only transactional email status (company admin) |
| `POST /api/companies/:slug/email/test` | Safe TEST_EMAIL to approved recipient |

## Operational troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| `permission_required` health | Mail.Send not consented or Exchange scope missing |
| `EMAIL_NOT_CONFIGURED` | No `company_email_config` row for tenant |
| `SENDER_NOT_ALLOWED` | Attempt to override From (blocked) |
| HTTP 403 from Graph | Application Mail.Send RBAC scope excludes mailbox |

## Future extension points

- Automation Engine typed notifications (internal service call only)
- Additional providers (customer-owned SMTP, dedicated transactional provider)
- Branding configuration (logo, colours) — not in V1

## Manual Microsoft step (Caddington V1)

Classification until Daniel completes Entra + Exchange steps and a real password-reset email is received:

**READY_FOR_MICROSOFT_PERMISSION**

1. Entra → App registrations → INFRA Microsoft 365 Connector → API permissions → Microsoft Graph → **Application** → add **Mail.Send** (do not add Mail.Read) → Grant admin consent
2. Exchange Online → ensure `admin@CaddingtonHoldings.co.uk` is in the INFRA approved mailboxes security group
3. Exchange Online → assign **Application Mail.Send** to the app scoped to that group (see guide in code)
4. Run `POST /api/companies/caddington-holdings/email/test` with `{ "recipient": "morghan@morghan.com" }` once
5. Run intentional password reset acceptance for Morghan
