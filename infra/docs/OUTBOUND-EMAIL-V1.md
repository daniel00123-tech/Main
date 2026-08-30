# INFRA Outbound Transactional Email

> Current sender and provider: Cloudflare Email, `Infra <noreply@infrastack.app>`. See [`../../docs/PRODUCTION_SERVICES.md`](../../docs/PRODUCTION_SERVICES.md).

All INFRA-generated customer email is sent as:

**Infra &lt;noreply@infrastack.app&gt;**

Tenants cannot replace this sender in V1. Company names still appear in the subject and body.

## Canonical identity

| Field | Value |
|---|---|
| Display name | Infra |
| Address | noreply@infrastack.app |
| Header | `Infra <noreply@infrastack.app>` |
| Reply-To | `noreply@infrastack.app` (unmonitored) |

Environment (infra-api):

- `EMAIL_FROM_NAME=Infra`
- `EMAIL_FROM_ADDRESS=noreply@infrastack.app`

Reserved future aliases (not monitored, no inbound routing in this version):

- `support@infrastack.app`
- `billing@infrastack.app`
- `admin@infrastack.app`

## Architecture

```
Application route (invite, reset, automation report, admin test)
        |
        v
sendTransactionalEmail({ companyId, type, recipient, subject, body })
        |
        +-- Platform sender resolver (always Infra <noreply@infrastack.app>)
        +-- Template renderer (@infra/shared)
        +-- Cloudflare Email Service (Workers EMAIL binding, REST fallback)
        +-- Resend only when RESEND_API_KEY is set (development)
        +-- email_outbox + company-scoped audit (no bodies in audit, no tokens)
```

Microsoft Graph `sendMail` is no longer used for product email. It remains only for Microsoft connector Mail.Send probes.

Stripe receipts and invoices continue to come from Stripe.

## Allowlisted types

- `PASSWORD_RESET`
- `USER_INVITATION`
- `TEST_EMAIL`
- `XERO_SALES_REPORT`
- `DOCUMENT_ACTIVITY_REPORT`

Reserved, not sendable: `AUTOMATION_ALERT`, `CONNECTOR_ALERT`, `APPROVAL_REQUEST`, `BILLING_ALERT`, `SECURITY_ALERT`, `REPORT_READY`.

## Customer links

Auth and portal links use `https://app.infrastack.app`. Do not put `pages.dev` in customer-facing email.

## Cloudflare Email Sending

Preferred provider. Domain onboarding (dashboard):

1. Cloudflare dashboard → **Compute** → **Email Service** → **Email Sending**
2. **Onboard Domain** → choose **infrastack.app**
3. Confirm DNS records on `cf-bounce.infrastack.app` (MX, SPF, DKIM) and `_dmarc.infrastack.app`
4. **Add records and onboard**

Wrangler binding:

```toml
[[send_email]]
name = "EMAIL"
```

## Failure handling

Send failure does not roll back user creation or automation report generation. `email_outbox` stores status, provider, message id, failure category, recipient, type, company, and timestamps. Retry count increments once per attempt. No infinite retry loop.

## Observability

Audit events: `email.send_started`, `email.sent`, `email.failed`. Detail includes type, recipient domain, provider, and failure category. Bodies and secrets are not logged.
