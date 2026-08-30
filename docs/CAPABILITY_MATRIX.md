# INFRA capability matrix

Status is based on **this branch’s code and Wrangler config**, not old PR titles.

| Status | Meaning |
| --- | --- |
| **Production** | Implemented, wired, and intended for live use |
| **Production — live UAT outstanding** | Implemented and configured; a live external proof is still missing or incomplete |
| **Partial** | Real code exists but is gated, catalogue-lagged, tenant-limited, or missing a path |
| **Planned** | Catalogue / ADR / types only — do not treat as shipped |

| Capability | Status | Runtime | Notes |
| --- | --- | --- | --- |
| Company / tenant control plane | Production | `infra-api` + D1 | Create company does not provision a Worker |
| Admin control panel | Production | Pages + API | Platform-admin only |
| Company portal | Production | Pages + API | `/portal/:slug`; legacy pages.dev subdomains still accepted |
| Canonical `infrastack.app` domains | Production | CF custom domains | Legacy workers.dev / pages.dev remain during cutover |
| Session auth + memberships | Production | API | Cookie `infra_session`; host-only on `app.infrastack.app` |
| Permissions / role presets | Production | API + shared | Per-company overrides; platform admin bypasses membership |
| INFRA MCP gateway | Production | `mcp.infrastack.app` | Service binding to company MCP; `search`/`fetch` adaptors |
| ChatGPT / Claude AI connections | Production | Gateway + service identities | ChatGPT snapshot must be republished after tool changes |
| Caddington Business MCP | Production | External Worker | Snapshot/inject in-repo; source is **not** migrated |
| HT / EL Business MCP | Partial | External Workers | Registered and routed; deeper integration paused |
| Google Drive | Production | Caddington MCP | Credentials stay on the company MCP; INFRA shows health/counts |
| Microsoft 365 hub (OAuth) | Production | `infra-api` Graph | Self-service wizard; tokens envelope-encrypted in D1 |
| SharePoint | Production | Graph ingest → company MCP | Knowledge pipeline + OCR fallback |
| OneDrive | Production | Graph ingest → company MCP | Same pipeline as SharePoint |
| Microsoft shared mailbox | Production | Graph + outlook MCP tools | Read + webhook notifications; Mail.Send is not the product email path |
| Microsoft Graph webhooks | Production | `api.infrastack.app` | Canonical notification URL derived from `INFRA_PUBLIC_API_URL` |
| Xero read | Production | `xero-core` + API + MCP | OAuth; tokens envelope-encrypted; data stays on Xero |
| Xero protected writes | Production | Action Engine | `FINANCIAL_WRITES_ENABLED=true`; **direct** MCP write tools remain blocked |
| OCR | Production | Azure Document Intelligence | Fallback for `requires_ocr`; Caddington knowledge backfill exists |
| Automations | Production | Engine + queue + cron | Templates: Xero sales email, document activity email; MCP/portal Run now |
| WhatsApp text | Production — live UAT outstanding | Meta + `infra-api` | V4.2 persist/fast-lane/watchdog. Need a live `wamid.HBg…` inbound row |
| WhatsApp buttons / lists | Production — live UAT outstanding | Meta interactive | Implemented in send + orchestrator |
| WhatsApp voice | Production — live UAT outstanding | Workers AI Whisper | Optional `OPENAI_API_KEY` fallback |
| Source links | Production | WhatsApp + knowledge fetch | URL preservation on knowledge hits; asked-for-source replies |
| Outbound product email | Production — live UAT outstanding | Cloudflare Email | From `Infra <noreply@infrastack.app>` only |
| Customer economics | Production | API + admin UI | Cost / charge / margin; never invent provider cost |
| Interactions | Production | API + admin UI | Groups operations when correlation is defensible |
| Quality auditor (per-turn) | Production | API (sampled) | Non-blocking; default sample rate 1 |
| Continuous Quality Loop | Production | API cron + admin UI | WhatsApp evaluator only; 60-day daily → Friday weekly |
| Stripe wallet top-up | Partial | API | Code allows live mode when secrets present. Caddington £1 acceptance PRs #338–#342 are **not** on this branch |
| Auto top-up | Partial | API | Gated by `AUTO_TOPUP_EXECUTION_ENABLED` |
| Connector catalogue WhatsApp row | Partial | shared catalogue | Runtime exists; catalogue still `coming_soon` / `isAvailable: false` |
| BigChange | Planned | — | Catalogue `coming_soon` |
| Commusoft | Planned | — | Catalogue `deferred` |
| GoHighLevel | Planned | — | Catalogue `coming_later` |
| Freshdesk | Planned | — | Catalogue `requires_setup`, not available |
| Custom API connector | Planned | — | Catalogue draft |
| Company data warehouse | Planned | — | ADR 030 only |
| Automated MCP provisioning | Planned | — | ADR 011 only |
| Quality loop for ChatGPT/Claude | Planned | — | Types exist; runner is WhatsApp-only |
| Inbound product email | Planned | — | Aliases reserved; not monitored |

Do not implement a capability marked Production unless you are fixing a proven bug. Check [PROJECT_STATUS.md](PROJECT_STATUS.md) before starting work.
