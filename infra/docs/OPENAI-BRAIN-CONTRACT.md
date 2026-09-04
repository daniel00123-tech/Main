# OpenAI brain contract

INFRA hosts one shared reasoning control plane. The model is a provider behind that plane. It is not a second product.

## Roles

| Role | Channel | What the user meets | User-visible brain |
| --- | --- | --- | --- |
| **PA** | `portal`, `portal_chat` | Staff / director assistant in Company Portal Chat | OpenAI on allowlisted EL, Cloudflare fallback |
| **Request** | `whatsapp` | Customer / business incoming requests | OpenAI on allowlisted EL, Cloudflare fallback |
| **Chatbot** | `chatgpt`, `mcp` | ChatGPT custom GPT calling INFRA tools | None. ChatGPT stays a chatbot on direct tools |
| **Automation** | smoke, daily improvement, benches | Internal jobs | Cloudflare user-visible; OpenAI may shadow |
| **Internal** | missing / unknown channel | Unscoped policy checks | Cloudflare user-visible when mode is `openai_shadow` |

## What OpenAI is, and is not

- OpenAI **is** the main brain for EL **PA** and **requests**: it plans, picks tools, reads evidence, and writes the user-visible answer.
- OpenAI **is not** wrapped around ChatGPT. ChatGPT already is a model. INFRA exposes OAuth / MCP tools only.
- Cloudflare Workers AI remains transport fallback on true OpenAI provider failure.
- Cloudflare remains the system of record for auth, RBAC, secrets, connectors, D1, usage, billing, audit, rate limits, and deploy.
- Caddington, HT, and future tenants stay on Cloudflare until they are explicitly allowlisted.

## Live flags

- `OPENAI_BRAIN_ENABLED=true`
- `OPENAI_BRAIN_MODE=openai_shadow` — do **not** flip the global mode to `openai_primary`
- `OPENAI_BRAIN_COMPANY_IDS=co_el`
- `OPENAI_BRAIN_PA_REQUEST_PRIMARY=true` — PA and request channels use OpenAI even while global mode is shadow
- Models: fast `gpt-5.6-luna`, default `gpt-5.6-terra`, reasoning `gpt-5.6-sol`

Unscoped `resolveBrainPolicy({ companyId: "co_el" })` with no channel must keep `useOpenAi=false` and `shadow=true`. Superstack deploy guards that invariant.
