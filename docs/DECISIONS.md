# INFRA decision log

Concise durable decisions. Full write-ups: [`infra/docs/adr/`](../infra/docs/adr/README.md). If an ADR and this file disagree, **verify in code** and then update both.

| Decision | Why it stays |
| --- | --- |
| **Cloudflare-first runtime** | Workers + D1 + Queues + Pages + Workers AI + Email. No second app server. |
| **Cursor is not runtime** | Cursor is for development only. WhatsApp, MCP, automations, and quality loop never call Cursor. |
| **Company MCP pattern** | Company MCPs own knowledge and business capabilities. INFRA owns identity, authz, routing, meter, wallet, audit (ADR 001). |
| **Canonical `infrastack.app` domains** | Portal `app.`, API `api.`, MCP `mcp.`. Legacy workers.dev / pages.dev stay until cutover completes. Host-only cookies on `app.infrastack.app`. |
| **Caddington MCP stays external** | Register + service-bind + snapshot/inject Xero. Do not rewrite the knowledge worker in this repo. |
| **Azure Document Intelligence for OCR** | Fallback when a document `requires_ocr`. Do not invent a second OCR vendor without a decision. |
| **Workers AI for initial voice STT** | WhatsApp voice notes use the `AI` binding (Whisper). Optional OpenAI fallback only. |
| **Cloudflare Email for product email** | Single platform sender `Infra <noreply@infrastack.app>`. Graph Mail.Send is not the product-email path. |
| **Action Engine for protected writes** | Plan → confirm → approve → execute. Direct MCP financial write tools stay blocked even though `FINANCIAL_WRITES_ENABLED=true`. |
| **Never invent provider costs** | Missing cost is unavailable, not £0 (ADR 003 / 031). |
| **WhatsApp is an AI channel** | Not a document connector. Identity is E.164 → user → company (ADR 016). Current runtime is V4.2, not the ADR’s “messaging disabled” sentence. |
| **Quality loop is bounded** | WhatsApp-only evaluator; 60-day daily 08:00 Europe/London then Friday weekly; high-risk patches are report-only. |
| **Secrets never in Git** | Wrangler secrets + envelope wrapping key. `base.worker.js` stays gitignored. |

Planning-only (not built): automated MCP provisioning (ADR 011), company warehouse (ADR 030).
