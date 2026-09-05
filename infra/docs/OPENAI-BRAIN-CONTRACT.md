# OpenAI brain contract

INFRA hosts one shared reasoning control plane. The model is a provider behind that plane. It is not a second product.

See also: [AGENTIC-INTELLIGENCE-STANDARD.md](./AGENTIC-INTELLIGENCE-STANDARD.md).

## Roles

| Role | Channel | What the user meets | User-visible brain |
| --- | --- | --- | --- |
| **PA** | `portal`, `portal_chat` | Staff / director assistant in Company Portal Chat | OpenAI primary on allowlisted EL and Caddington, Cloudflare fallback |
| **Request** | `whatsapp` | Customer / business incoming requests | OpenAI primary on allowlisted EL and Caddington, Cloudflare fallback |
| **Chatbot** | `chatgpt`, `mcp` | ChatGPT custom GPT calling INFRA tools | None. ChatGPT stays a chatbot on direct tools |
| **Automation** | smoke, daily improvement, benches | Internal jobs | Cloudflare user-visible |
| **Internal** | missing / unknown channel | Unscoped policy checks | Cloudflare user-visible |

## What OpenAI is, and is not

- OpenAI **is** the primary agentic brain for allowlisted **PA** and **requests**: it plans, picks tools, inspects evidence, recovers from insufficient routes, and writes the user-visible answer.
- OpenAI **is not** wrapped around ChatGPT. ChatGPT already is a model. INFRA exposes OAuth / MCP tools only.
- Cloudflare Workers AI remains transport fallback on true OpenAI provider failure.
- Cloudflare remains the system of record for auth, RBAC, secrets, connectors, D1, usage, billing, audit, rate limits, and deploy.
- HT and future tenants stay on Cloudflare until they are explicitly allowlisted.

## Live flags

- `OPENAI_BRAIN_ENABLED=true`
- `OPENAI_BRAIN_MODE=openai_primary` — EL and Caddington conversational path
- `OPENAI_BRAIN_COMPANY_IDS=co_el,co_caddington`
- `OPENAI_BRAIN_PA_REQUEST_PRIMARY=true` — belt-and-suspenders for PA/request even if mode is later rolled back
- Models: fast `gpt-5.6-luna`, default `gpt-5.6-terra`, reasoning `gpt-5.6-sol`

Unscoped `resolveBrainPolicy({ companyId: "co_el" })` or `co_caddington` with no channel must keep `useOpenAi=false` and Cloudflare user-visible. Superstack deploy guards that invariant. HT must stay off the allowlist.
