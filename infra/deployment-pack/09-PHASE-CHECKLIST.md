# Phase Checklist — INFRA Go-Live

Print this page and tick off as you go.

---

## Phase 1 — Infrastructure ☐

- [ ] Cloudflare account created
- [ ] Domain added to Cloudflare DNS
- [ ] Nameservers updated at registrar
- [ ] Node.js 20+ installed locally
- [ ] `wrangler login` completed
- [ ] Repo cloned: `git clone …/Main.git`
- [ ] `cd infra && npm install`
- [ ] D1 database created: `wrangler d1 create infra-control-plane`
- [ ] `database_id` added to `packages/api/wrangler.toml`
- [ ] Migrations applied remote: `wrangler d1 migrations apply infra-control-plane --remote`
- [ ] API deployed: `cd packages/api && wrangler deploy`
- [ ] Custom domain attached: `api.infra.yourdomain.com`
- [ ] Health check passes: `curl https://api.infra.yourdomain.com/health`
- [ ] Admin UI built: `cd packages/web && npm run build`
- [ ] Pages deployed and domain attached: `admin.infra.yourdomain.com`
- [ ] Company portal domain: `app.infra.yourdomain.com`

**Phase 1 complete date:** _______________

---

## Phase 2 — Caddington MCP loop ☐

- [ ] Caddington MCP endpoint URL documented
- [ ] Registered in INFRA admin as external MCP
- [ ] Health check passing
- [ ] ChatGPT connected to Caddington MCP (documented in AI Clients)
- [ ] Usage events POST to INFRA API
- [ ] Test query runs end-to-end
- [ ] Simulated billing debits Caddington credits
- [ ] Audit log shows events

**Phase 2 complete date:** _______________

---

## Phase 3 — Stripe & company portal ☐

- [ ] Stripe test mode configured
- [ ] Webhook endpoint live and verified
- [ ] `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in Worker secrets
- [ ] Test top-up £50 succeeds
- [ ] Ledger shows CREDIT entry
- [ ] Company portal auth working
- [ ] Charlie can log into EL portal (EL only)
- [ ] HT owner sees HT only
- [ ] Roles assigned (engineer, office_staff, etc.)

**Phase 3 complete date:** _______________

---

## Phase 4 — EL / HT connectors (developer-led) ☐

- [ ] EL BigChange: approval documented (company, service, permissions)
- [ ] HT Commusoft: approval documented
- [ ] No legacy Nirvana/Aquilo/Urban Maintenance credentials used
- [ ] Connector built in Cursor
- [ ] MCP tools registered in INFRA
- [ ] EL portal shows "Connected" for BigChange
- [ ] HT portal shows "Connected" for Commusoft
- [ ] Read permission tested (engineer schedule query)
- [ ] Write permission tested (office staff booking)
- [ ] Write denied tested (engineer booking attempt)

**Phase 4 complete date:** _______________

---

## Phase 5 — Definitions & Cursor bridge ☐

- [ ] Company definitions schema migrated
- [ ] EL revenue rule example stored
- [ ] BigChange glossary ("parent contact") stored
- [ ] Correction capture logging
- [ ] Cursor manual runbook push tested
- [ ] Cursor bridge API (v0.2 prep) documented

**Phase 5 complete date:** _______________

---

## Phase 6 — Self-service (v0.2, future) ☐

- [ ] "Connect now" connector UI
- [ ] Owner approval of definitions in portal
- [ ] Automated Cursor escalation webhook
- [ ] WhatsApp gateway design review

---

## Credentials & secrets log (keep private)

| Secret | Stored in | Date set |
| --- | --- | --- |
| D1 database_id | wrangler.toml | |
| STRIPE_SECRET_KEY | Worker secret | |
| STRIPE_WEBHOOK_SECRET | Worker secret | |
| SESSION_SECRET | Worker secret | |
| CURSOR_BRIDGE_SECRET | Worker secret | |

**Never commit secrets to git.**

---

## Key URLs (fill in)

| Service | URL |
| --- | --- |
| API | https://api.infra._______________ |
| Admin | https://admin.infra._______________ |
| Company portal | https://app.infra._______________ |
| Caddington MCP | https://_______________________ |
| GitHub repo | https://github.com/daniel00123-tech/Main |

---

## Notes

_Use this space for deployment notes, error resolutions, account IDs._

```




```
