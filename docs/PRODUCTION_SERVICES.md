# INFRA production service map

Secret **values** are never recorded here. Names only.

## Canonical URLs

| Role | Canonical | Legacy |
| --- | --- | --- |
| Portal | `https://app.infrastack.app` | `https://infra-web.pages.dev` |
| API | `https://api.infrastack.app` | `https://infra-api.daniel-dwyer123.workers.dev` |
| MCP | `https://mcp.infrastack.app/api/gateway/v1/mcp` | legacy API host + same path |
| Site | `https://infrastack.app` | — |

OAuth / webhook paths (canonical host `api.infrastack.app`):

- Xero: `/api/connectors/xero/oauth/callback`
- Microsoft: `/api/connectors/microsoft/oauth/callback`
- Stripe: `/api/stripe/webhook`
- Graph: `/api/webhooks/microsoft/graph`
- WhatsApp: `/api/webhooks/whatsapp`

## Workers and frontends

### `infra-api`

| | |
| --- | --- |
| Purpose | Control plane: auth, MCP gateway, connectors, billing, automations, WhatsApp, OCR orchestration, quality loop |
| Config | `infra/packages/api/wrangler.toml` |
| Canonical URL | `https://api.infrastack.app` (MCP also `https://mcp.infrastack.app`) |
| D1 | `DB` → `infra-control-plane` |
| Queues | producers/consumers: `whatsapp-inbound`, `automation-runs`, `microsoft-knowledge-ingest` + matching `*-dlq` |
| R2 | none |
| Vectorize | none |
| Workers AI | `AI` — WhatsApp voice STT (Whisper) |
| Email | `EMAIL` send_email binding — `Infra <noreply@infrastack.app>` |
| Service bindings | `CADDINGTON_MCP`, `HT_BUSINESS_MCP`, `EL_BUSINESS_MCP` |
| Cron | `0 */6 * * *` Microsoft sync; `*/15 * * * *` automations + WhatsApp reaper + quality-loop cadence |
| Important vars | `ENVIRONMENT`, `ALLOWED_ORIGINS`, `INFRA_PUBLIC_API_URL`, `INFRA_PUBLIC_MCP_URL`, `PORTAL_PUBLIC_ORIGIN`, `PORTAL_BASE_DOMAIN`, `EMAIL_FROM_*`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_OUTBOUND_AI_ENABLED` |

### `infra-web` (Cloudflare Pages)

| | |
| --- | --- |
| Purpose | Admin + company portal SPA |
| Canonical URL | `https://app.infrastack.app` |
| Proxy | `functions/api/[[path]].js` → `https://api.infrastack.app` |
| Bindings | none (Pages functions only) |

### `caddington-mcp`

| | |
| --- | --- |
| Purpose | Caddington Business MCP (knowledge + Drive + injected Xero) |
| Config | `infra/packages/caddington-mcp/wrangler.toml` |
| Direct URL | `https://caddington-mcp.<account>.workers.dev/mcp` — AI clients should use the INFRA gateway, not this |
| D1 | `CADDINGTON_BUSINESS_DATA` → `caddington-business-data` |
| R2 | `CADDINGTON_KNOWLEDGE` |
| Vectorize | `CADDINGTON_KNOWLEDGE_INDEX` |
| Workers AI | `AI` |
| Queue | `caddington-gdrive-sync` |
| Vars | `INFRA_API_URL=https://api.infrastack.app`, `INFRA_MCP_ENVIRONMENT_ID=mcp_caddington_primary` |

### External (not in this repo)

| Worker | Purpose |
| --- | --- |
| `ht-business-mcp` | HT company MCP — registered, paused |
| `el-business-mcp` | EL company MCP — registered, paused. Separate PR stack #288 / #383 |

## Secret names (`infra-api`)

Required for core + Caddington routing:

- `SESSION_SECRET`
- `CADDINGTON_MCP_AUTH_TOKEN` (same value as Caddington Worker `MCP_AUTH_TOKEN`)
- `HT_MCP_AUTH_TOKEN`, `EL_MCP_AUTH_TOKEN` (same values as those Workers’ `MCP_AUTH_TOKEN` — do not rotate casually)

Credential wrapping:

- `INFRA_CREDENTIAL_WRAPPING_KEY`
- `INFRA_CREDENTIAL_KEY_VERSION` (optional, default `v1`)

Xero:

- `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`
- `XERO_OAUTH_REDIRECT_URI` (canonical `https://api.infrastack.app/api/connectors/xero/oauth/callback`)

Microsoft:

- `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_REDIRECT_URI` / `MICROSOFT_MULTITENANT_APP` (optional)
- `CADDINGTON_ADMIN_TOKEN` (knowledge admin bridge)

OCR:

- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`
- `AZURE_DOCUMENT_INTELLIGENCE_KEY`
- `AZURE_OCR_MAX_PAGES`, `AZURE_OCR_MAX_BYTES`, `AZURE_OCR_MIN_SUBSTANTIVE_CHARS` (optional)

WhatsApp:

- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- `WHATSAPP_ACCESS_TOKEN`
- `META_APP_SECRET`
- `WHATSAPP_REGISTRATION_PIN` (optional 6-digit; never guess)
- `WHATSAPP_META_PROBE_KEY` (optional one-shot; unset in normal prod)
- `OPENAI_API_KEY` (optional Whisper fallback)

Stripe:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET` (legacy workers.dev)
- `STRIPE_WEBHOOK_SECRET_INFRASTACK` (canonical host)

Email / ops:

- `EMAIL_LIVE_TEST_KEY` (optional one-shot)
- `RESEND_API_KEY` (dev fallback only; production uses Cloudflare Email)
- `AUTO_TOPUP_EXECUTION_ENABLED`
- `XERO_SEND_UAT_MODE`, `XERO_SEND_TEST_RECIPIENT`

There is **no** `MICROSOFT_GRAPH_NOTIFICATION_URL` secret — the URL is derived from `INFRA_PUBLIC_API_URL`.

## Secret names (`caddington-mcp`)

- `MCP_AUTH_TOKEN`
- `CADDINGTON_ADMIN_TOKEN`

## External providers

| Provider | Used for |
| --- | --- |
| Meta WhatsApp Cloud API | Inbound webhook + outbound text/interactive/media |
| Azure AI Document Intelligence | OCR fallback |
| Xero | Accounting read + Action Engine writes |
| Microsoft Graph | SharePoint, OneDrive, mailbox, (legacy Graph Mail.Send path unused for product email) |
| Cloudflare Email | Product transactional email |
| Cloudflare Workers AI | Voice-note transcription |
| Stripe | Wallet top-up (live acceptance PRs not on this branch) |
| OpenAI | Optional STT fallback |
