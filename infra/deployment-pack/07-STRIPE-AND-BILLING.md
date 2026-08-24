# Stripe & Billing Setup

## Commercial model

INFRA uses **prepaid credit** — not a banking wallet.

```
Customer tops up £100 via Stripe
    → CREDIT ledger entry
    → Balance +£100

Each AI/MCP/connector operation
    → DEBIT ledger entry
    → Balance reduced
```

Card data **never** stored in INFRA. Stripe handles payments.

---

## Stripe test mode (v0.1)

### Setup steps

1. Create Stripe account: https://dashboard.stripe.com/register
2. Ensure **Test mode** toggle is ON (top right)
3. Developers → API keys → copy **Secret key** (`sk_test_...`)
4. Developers → Webhooks → Add endpoint:
   - URL: `https://api.infra.yourdomain.com/webhooks/stripe`
   - Events: `checkout.session.completed`, `payment_intent.succeeded`
5. Copy webhook signing secret (`whsec_...`)

### Store in Cloudflare

```bash
cd infra/packages/api
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
```

### Test card

```
Number: 4242 4242 4242 4242
Expiry: any future date
CVC: any 3 digits
```

---

## Billing flow

```
Charlie (EL Owner) → Company portal → Billing → Top up £50
        ↓
Stripe Checkout (hosted by Stripe)
        ↓
Payment succeeds
        ↓
Stripe webhook → INFRA API
        ↓
INFRA verifies webhook signature + idempotency
        ↓
Append CREDIT to immutable ledger
        ↓
Update EL credit balance
        ↓
Charlie sees £50 credit in portal
```

**Critical:** Never credit account because browser says success. Webhook required.

---

## Usage debits

Each operation creates a usage event:

| Operation | Example charge |
| --- | --- |
| Knowledge search | £0.02 |
| BigChange read | £0.05 |
| BigChange write | £0.80 |
| Invoice create | £1.20 |
| AI request (tokens) | varies |

Stored with: `request_id`, `actual_cost`, `customer_charge`, `margin`, `pricing_rule_version`

---

## Simulated Caddington billing (first test)

Starting credit: £100.00

After test operations:
- Knowledge searches
- MCP queries  
- Document processing

Portal shows: starting balance, debits, ending balance, margin.

See design doc Section 14–16 for ledger schema.

---

## Production payments

**Not in v0.1.** When ready:
- Switch to Stripe live keys (`sk_live_`)
- Update webhook endpoint for production
- Legal/compliance review before taking real customer payments

Auto top-up: designed but disabled in v0.1.

---

## Company portal billing pages

Prototype at `/portal/billing` (EL Business mock):
- Current balance
- Top-up buttons (£50, £100, £250, £500)
- Transaction history (immutable ledger view)

---

See **`02-SETUP-GUIDE.md` Section 11** for deployment integration steps.
