# OpenAI reasoning project — internal handoff map

Do not implement OpenAI from this file. This is a seat map only.

Live production at last check was **not** the Portal Chat UX Worker. Confirm `/health` SHA before any deploy. Last-write `wrangler deploy` still wins.

## Surfaces

| Surface | Shared intelligence? | Entry |
|---|---|---|
| Portal Chat | Yes | `sendPortalChatMessage` → `buildConversationState` → `createPortalChatRuntime` → `runIntelligenceTurn({ channel: "portal" })` |
| WhatsApp | Yes | `whatsapp-orchestrator` → `executeWhatsAppIntelligence` → `runIntelligenceTurn({ channel: "whatsapp" })` |
| ChatGPT / INFRA MCP | **Bypasses** `runIntelligenceTurn` | `mcp-gateway.ts` `tools/call` → Action Engine or `executeGatewayRequest`. Tool choice is the ChatGPT client. RBAC / billing still apply at the gateway. |

## Workers AI (current completer)

`createDefaultCompleter` in `provider.ts` when `env.AI` is set.

- Primary: `@cf/meta/llama-4-scout-17b-16e-instruct`
- Fallback: `@cf/meta/llama-3.1-8b-instruct-fast`
- `DEFAULT_OPENAI_TEXT_MODEL = "gpt-4o-mini"` is leftover V1. **Not called.** Comment: “V1.1 does not call OpenAI.”

Greetings and deterministic business-system reads skip the model (`fast-path.ts`, `shouldRunDeterministicRead`).

## web_search

- Implementation (UX branch only): `intelligence/web-search.ts`
- Weather: Open-Meteo. Generic public: DuckDuckGo Instant Answer.
- Exposed on Portal + WhatsApp runtimes and the intelligence catalogue. Never instead of Xero / Outlook / company files.
- Usage: `action=web_search`, `settlementStatus=zero_charge`.
- **Not on current live Worker** (`cursor/el-knowledge-onedrive-b8da`). Do not expand until the OpenAI project decides whether to keep, wrap, or replace it.

## Evidence memory

| Channel | Store |
|---|---|
| Portal | D1 `portal_conversations.context_json` + `portal_conversation_messages`. Includes `lastMailboxAddress` / `lastEmailMessageId` on the UX branch. |
| Intelligence turn | `IntelligenceConversationState` (current doc, last topic/tool/answer, mailbox ids on UX branch). |
| WhatsApp | `WhatsAppEntityMemory` — last tool/topic/answer/document. No `lastMailboxAddress` yet. |

## Response quality guard seat

Keep **scope / tool routing** in `classifyScope`. Business systems must outrank web.

Natural OpenAI seat:

1. After deterministic read / tool results
2. Before the user-visible reply
3. After `collectQualityFlags` (`intelligence/quality.ts`)
4. Beside `polishPortalReply` / `verbalise-business.ts` (hollow-retry replacement)

Do not let a reasoning model re-pick Xero vs Outlook vs knowledge. Use it to verbalise grounded tool output and to refuse invention.

## Concurrent deploy gap (still open)

`assert-production-superstack.mjs` only runs **local** `production-superstack.guard.test.ts`. It does not fetch live `/health`, require ancestor rebase, lock the Worker, or deploy web+api atomically.

Proven overwrite: UX `2865bc0` / Worker `58af46f8-9d06-470f-b651-6c739067f229` was replaced by later `cursor/el-knowledge-onedrive-b8da` deploys. Merge onto the live tip before any new Worker push.
