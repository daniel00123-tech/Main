# Cloudflare Hosting Reference

## Why Cloudflare

The Caddington MCP proof-of-concept already uses Cloudflare successfully (Workers, R2, D1, Vectorize). INFRA uses the same platform for consistency.

---

## Services used

| Service | INFRA usage | Pricing note |
| --- | --- | --- |
| **Workers** | Control plane API, webhooks, cron, future connector workers | Free tier generous; paid for scale |
| **D1** | Control plane database (companies, billing, audit) | Free tier OK for v0.1 |
| **Pages** | Admin UI + company portal | Free for static/React builds |
| **R2** | Customer documents (per company, later) | Pay per storage/ops |
| **Vectorize** | Customer vector indexes (later) | Pay per usage |
| **Queues** | Async usage events, sync jobs (later) | Pay per message |
| **Cron Triggers** | MCP health checks, automations | Included with Workers |
| **Workers Secrets** | Stripe keys, connector credential refs | Free |
| **DNS** | Domain routing | Free on Cloudflare |
| **SSL** | HTTPS everywhere | Free |

**No VPS, no AWS, no Azure required for v0.1.**

---

## Account setup checklist

- [ ] Create account at https://dash.cloudflare.com/sign-up
- [ ] Add payment method (optional for free tier; needed for some paid features)
- [ ] `npm install -g wrangler && wrangler login`
- [ ] Note Account ID (Dashboard → zone → Overview)

---

## Domain setup checklist

- [ ] Register domain (Cloudflare Registrar or external)
- [ ] Add site to Cloudflare DNS
- [ ] Point registrar nameservers to Cloudflare
- [ ] SSL/TLS → Full (strict)
- [ ] Create DNS records (or let Workers/Pages auto-create):

```
api.infra.yourdomain.com    → Worker route
admin.infra.yourdomain.com  → Pages project
app.infra.yourdomain.com    → Pages project (same or separate)
```

---

## Deploy checklist

```bash
# 1. D1
wrangler d1 create infra-control-plane
# → paste database_id into wrangler.toml

# 2. Migrations
wrangler d1 migrations apply infra-control-plane --remote

# 3. Secrets
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put SESSION_SECRET

# 4. API
cd infra/packages/api && wrangler deploy

# 5. UI
cd infra/packages/web && npm run build
wrangler pages deploy dist --project-name=infra-web
```

---

## Custom domains in dashboard

**Worker (API):** Workers & Pages → infra-api → Settings → Domains → Add `api.infra.yourdomain.com`

**Pages (UI):** Workers & Pages → infra-web → Custom domains → Add `admin.infra.yourdomain.com` and `app.infra.yourdomain.com`

---

## Environment separation

| Environment | D1 | Worker name | Purpose |
| --- | --- | --- | --- |
| Local dev | `.wrangler/state` local D1 | `wrangler dev` | Development |
| Production | Remote D1 `infra-control-plane` | `infra-api` | Live |

Use separate Stripe keys: `sk_test_` for test, `sk_live_` only when ready for production payments.

---

## Monitoring

- Cloudflare Dashboard → Workers → infra-api → Metrics
- INFRA admin → System Health page
- MCP health cron (implement in Stage 2)

---

See **`02-SETUP-GUIDE.md`** for full step-by-step instructions.
