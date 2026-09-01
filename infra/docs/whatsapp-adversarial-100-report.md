# WhatsApp adversarial 100 — Caddington × Elvex

Frozen suite `adversarial-100-v1`. Branch `cursor/infra-whatsapp-adversarial-100-d3d8` from `cursor/infra-quality-buttons-mobile-d3d8`.

Compare: https://github.com/daniel00123-tech/Main/compare/cursor/infra-quality-buttons-mobile-d3d8...cursor/infra-whatsapp-adversarial-100-d3d8

Webhook unchanged: `https://api.infrastack.app/api/webhooks/whatsapp`. No new Worker, LLM provider, or Action Engine change. Cursor is not in the customer runtime.

## A. What this pass is

50 distinct intents (greeting through a 10–15 turn mini conversation), run on Caddington and Elvex = **100 evaluated scenarios**. Same intents both sides. Only `{primary} {alt} {unknown} {invoice} {mailbox}` are tenant-adapted. No Van Policy / CV 2015 / Coal Search / William special-cases.

## B. Architecture (unchanged)

WhatsApp → Meta → infra-api → RBAC → Conversational Intelligence → Workers AI Scout `@cf/meta/llama-4-scout-17b-16e-instruct` + fallback `@cf/meta/llama-3.1-8b-instruct-fast` → tools → WhatsApp.

Routes remain FAST_LOCAL / INTELLIGENT / CONTROLLED_ACTION. Scope before tools.

## C. Harness

Reusable files:

- `packages/api/src/services/intelligence/eval/adversarial-scenarios.ts`
- `packages/api/src/services/intelligence/eval/adversarial-runner.ts`
- `packages/api/src/services/intelligence/eval/adversarial-score.ts`
- `packages/api/src/services/intelligence/eval/adversarial-100.json`

Gated route (no WhatsApp send): `POST /api/internal/intelligence-eval` actions `adversarial-offline` | `adversarial-persist`.

## D. Tenants and identities (no secrets)

| Tenant | Company | Connectors | WhatsApp identity | UAT send |
| --- | --- | --- | --- | --- |
| Caddington | `co_caddington` / Caddington Holdings | Google Drive, Microsoft 365, Xero | Dan Hold `+447932609444` (authorised) | Allowed if gated; not sent this pass |
| Elvex | `co_el` / EL Business | OneDrive, SharePoint, Outlook shared, Xero | Ella Mae is a WhatsApp-linked director. William `+447933229445` is a member and was **not** messaged | Not authorised as UAT — persist/offline only |

`EL_MCP_AUTH_TOKEN` is already present on infra-api. It was not rotated or invented.

## E. Transport labels

| Label | Meaning | This pass |
| --- | --- | --- |
| OFFLINE | Policy + live scope/router + mocked tenant-neutral tools | **Used for the official 100 and the 20-turn scripts** |
| GATED | Persist-inclusive against live D1 + connectors, no Meta send | Route ready; full 100 not executed against live Scout in this environment |
| REAL META | Live `wamid.HBg…` | **Not used.** No unsolicited WhatsApp. `WHATSAPP_META_PROBE_KEY` is not set; nothing to delete |

## F. Baseline (before systemic fixes)

Official scoring later rolled mini-conversation into one scenario. Raw turn capture before that:

- 126 captured turns (49 singles + 14 mini turns, × 2 tenants)
- Avg **93.2** / 100
- GOOD 79.4% · ACCEPTABLE 20.6% · POOR 0 · UNUSABLE 0
- Invented 0 · grounded 100% · assistant-like 96.8%
- Caddington 93.3 · Elvex 93.0

CENTRAL misses: period compare routed to company search; bare corrections searched instead of asking; mini-conversation scored against the greeting; a few search-form clarifies.

## G. Clusters (baseline)

| Cluster | Count | Notes |
| --- | --- | --- |
| CENTRAL | 26 | Scope/tool/style — not tenant data |
| CADDINGTON-DATA | 0 | Offline tools succeeded |
| ELVEX-DATA | 0 | Offline tools succeeded (auth gap not applied offline) |
| RBAC | 0 | |
| SEARCH/INDEX | 0 | |
| MODEL | 0 | Policy completer, not live Scout |
| TRANSPORT | 0 | |

## H. Systemic fixes (one cause → many tests)

1. **Tool discipline** — honour classified scope. Do not force company-wide search on every correction. Bare “that’s not what I meant” clarifies. “I meant the whole system” stays SYSTEM_META. If scope is finance/meta and the model picks a document search, rewrite to the scoped tool.
2. **Period compare** — “Compare this month with last month” is a calendar-to-calendar finance read, not a document hunt. Tightened so “compare last year’s skip hire quotes…” still searches the library.
3. **Style** — greetings and found-file replies lead like an assistant, not a search form.
4. **Hybrid ranking** — phrase / filename-stem / distinctive-token boost; generic-only hits stay weak.

No tenant-named special cases.

## I. 20-turn adversarial (after fixes)

Same 20-turn script on both tenants (Hi → capabilities → find → follow-ups → correction → finance → mailbox → controlled write → thanks). Offline: 20/20 per tenant, 0 invented, 0 UNUSABLE.

## J. After scores (same 100, unchanged intents)

| | Before (raw turns) | After (official 100) |
| --- | --- | --- |
| Cases | 126 turns / 100 tenant-scenarios | **100** |
| Avg | 93.2 | **99.2** |
| GOOD % | 79.4 | **100** |
| ACCEPTABLE % | 20.6 | **0** |
| POOR / UNUSABLE | 0 / 0 | **0 / 0** |
| Invented | 0 | **0** |
| Assistant-like % | 96.8 | **100** |
| Grounded % | 100 | **100** |
| Caddington avg | 93.3 | **99.4** |
| Elvex avg | 93.0 | **99.0** |

Objectively better: higher average, no invented answers, no UNUSABLE, more assistant-like, existing intelligence tests green (including the “I meant the whole system” gate).

## K. Honesty about OFFLINE vs live Scout

These 100 scores use the **same scope/router/tools path** with the policy completer, not live Llama 4 Scout synthesis. That is the right gate for CENTRAL routing/style/ranking. Live connector answers can still fail on EL/Caddington index quality, RBAC, or model JSON. That is why persist-inclusive remains labelled GATED and was not scored as REAL META.

## L. Regression gates

- Intelligence + adversarial + scope + quality-v13 + V4.1/V5/V47 tests passed after the fixes
- Invented answers did not increase
- UNUSABLE did not increase
- Avg score improved
- No new Worker / provider / Action Engine / MCP auth rewrite

## M. Deploy

After-scores improved and gates passed → existing `infra-api` deployed twice (fixes, then batched persist route).

- Version `6159a776-ee96-4b37-9422-d1af4eba6a1b` — systemic intelligence fixes
- Version `fed669fe-fafa-44bb-8347-e92b04313d8b` — batched persist eval
- Webhook still `https://api.infrastack.app/api/webhooks/whatsapp` (GET without hub params → 403 `Invalid verification request`, as designed)

## N. Live UAT

- Caddington: Dan Hold is the authorised WhatsApp UAT number. **No message sent** (no probe key, no unsolicited send).
- Elvex: Ella Mae is the persist identity (director, WhatsApp-linked). William was not messaged. **No Meta send.**
- REAL META required `wamid.HBg…` — none.
- `WHATSAPP_META_PROBE_KEY` was not created; nothing to delete.
- A temporary `ADVERSARIAL_EVAL_KEY` was set only to smoke the persist route on `api.infrastack.app`, which returned 404 (custom-domain auth/propagation). The key was deleted immediately and is not present on infra-api.

## O. Remaining gaps

- Live Scout persist-inclusive 100 against Caddington + Elvex connectors still to be run in batches through the gated route when an operator is watching (one Worker request cannot finish 100 live Scout turns)
- Elvex WhatsApp UAT identity is not signed off — persist only
- Hybrid ranking helps title collisions; weak OCR / empty chunks remain a SEARCH/INDEX risk on live data
- Controlled writes stay on Action Engine — unchanged

## P–Z. Scenario list (50 intents)

greeting, casual, thanks, capabilities, identity, connected_systems, index_count, find_named_document, open_named_document, followup_summarise, followup_main_points, followup_pronoun, followup_when, followup_who, rephrase_simpler, source_link, no_evidence_in_current, search_other_documents, switch_named_document, return_previous_document, ambiguous_policy, ambiguous_find_document, typo_find, typo_followup, correction_not_meant, correction_wrong_file, sales_this_month, sales_period_followup, compare_periods, overdue_invoices, pnl, named_invoice, mailbox_search, unread_inbox, write_create_invoice, write_send_or_delete, index_count_while_doc_open, capability_while_doc_open, unknown_document, vague_help, remind_me, broaden_search, is_that_allowed, what_happens_if, permission_honesty, connector_honesty, multi_hop_switch_then_ask, underspecified_quantity, messy_voice_like, mini_conversation.

## AA. Write-out for Daniel

We did not rebuild WhatsApp. We built a frozen 50-intent pack and ran it on both companies (100 scenarios). Offline baseline was already decent but it still behaved like a search box on corrections, period compares, and “which file?” prompts. We fixed those in the shared brain — scope, tool choice, ranking, and tone — so they apply to every tenant, not just Caddington filenames. After the same 100, every scenario scored GOOD and nothing was invented. We did not text anyone. Elvex’s token was already on the API; we left it alone. William was not used. If you want the live WhatsApp feel, the next step is a watched persist run on Dan’s number only, then sign off an Elvex UAT number (Ella is the obvious candidate).
