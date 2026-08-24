# INFRA Deployment Pack — Start Here

**Version:** v0.1  
**Date:** August 2026  
**Repository:** `Main` → `infra/` folder  
**Branch:** `cursor/infra-platform-v0-1-d3d8`

---

## What this pack is

A complete documentation bundle for building, hosting, and operating **INFRA** — the administration and control platform for business AI infrastructure.

Use it with **ChatGPT** (recommended) or follow manually. All hosting is designed for **Cloudflare** (Workers, D1, Pages).

---

## How to use with ChatGPT

1. Extract this zip folder
2. Open **`08-CHATGPT-WALKTHROUGH-PROMPT.md`**
3. Copy the master prompt into ChatGPT
4. Attach or paste **`02-SETUP-GUIDE.md`** (and other docs as needed)
5. Ask ChatGPT to walk you through **Phase 1** step by step, confirming each step before continuing

---

## Document index (read in this order)

| # | File | Purpose |
| --- | --- | --- |
| **ADR** | [`../docs/adr/001-company-mcp-vs-infra-boundary.md`](../docs/adr/001-company-mcp-vs-infra-boundary.md) | **Authoritative:** Company MCP vs INFRA boundary |
| 01 | `01-FULL-STRUCTURE-AND-OVERVIEW.md` | What INFRA is, two portals, full system map |
| 02 | `02-SETUP-GUIDE.md` | **Main go-live guide** — Cloudflare, domain, deploy |
| 03 | `03-ARCHITECTURE-DESIGN.md` | Detailed architecture, schema, billing, definitions |
| 04 | `04-CURSOR-BRIDGE.md` | Cursor ↔ INFRA query box when AI is unsure |
| 05 | `05-ROLES-READ-WRITE-PERMISSIONS.md` | Engineer → Director roles, read/write commands |
| 06 | `06-CLOUDFLARE-HOSTING-REFERENCE.md` | Cloudflare services, DNS, costs, checklist |
| 07 | `07-STRIPE-AND-BILLING.md` | Prepaid credits, Stripe test mode, webhooks |
| 08 | `08-CHATGPT-WALKTHROUGH-PROMPT.md` | Ready-made prompts for ChatGPT |
| 09 | `09-PHASE-CHECKLIST.md` | Printable phase-by-phase checklist |
| 10 | `10-REPO-STRUCTURE.md` | What's in the `infra/` monorepo code |

---

## Quick answers

### Where do I host it?
**Cloudflare** — no separate VPS needed.
- API → Cloudflare **Workers**
- Database → Cloudflare **D1**
- Admin + company UI → Cloudflare **Pages**
- Future customer data → **R2**, **Vectorize** (per company)

### What domain do I need?
One domain (e.g. `yourdomain.com`) with subdomains:

```
api.infra.yourdomain.com     → API
admin.infra.yourdomain.com   → Platform admin (you)
app.infra.yourdomain.com     → Company portal (EL, HT, etc.)
```

### What accounts do I need?
- Cloudflare (free tier OK to start)
- GitHub (repo already exists)
- Stripe (test mode for v0.1)
- Domain registrar (or buy domain via Cloudflare)

### First thing to deploy?
1. D1 database + API Worker
2. Admin UI on Pages
3. Register **Caddington MCP** (existing) — prove metering loop
4. Then EL BigChange / HT Commusoft (developer-led via Cursor)

---

## Security reminder

INFRA must have **no connection** to legacy Nirvana, Aquilo, or Urban Maintenance systems or credentials.

Before any live external connection: document company, service, permissions, and obtain explicit approval.

---

## Support documents in the codebase

After deployment, live docs remain in the git repo at:
- `infra/docs/SETUP-GUIDE.md`
- `infra/docs/DESIGN.md`
- `infra/docs/CURSOR-BRIDGE.md`
- `infra/README.md`

---

*Pack generated for Daniel — INFRA v0.1 deployment.*
