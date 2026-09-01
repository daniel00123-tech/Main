# WhatsApp live document Q&A / short follow-up hardening

Branch `cursor/infra-whatsapp-live-docqa-d3d8` from `cursor/infra-whatsapp-adversarial-100-d3d8` (PR #418).

Compare: https://github.com/daniel00123-tech/Main/compare/cursor/infra-whatsapp-adversarial-100-d3d8...cursor/infra-whatsapp-live-docqa-d3d8

Webhook unchanged: `https://api.infrastack.app/api/webhooks/whatsapp` (GET without hub params → 403 `Invalid verification request`). No new Worker, LLM provider, Action Engine, OAuth, or Xero change. Cursor is not in the customer runtime. Models unchanged: Scout `@cf/meta/llama-4-scout-17b-16e-instruct`, fallback `@cf/meta/llama-3.1-8b-instruct-fast`.

The offline adversarial-100 score of 99.2 is **not** proof this is solved. That suite uses the policy completer. This pass is about live document conversations: selected `document_id`, chunks, short follow-ups, ranking, synthesis, and switch/reset.

## A. Trace (selected document)

`search_company_knowledge` hit → `id` + `title` → adopt onto `currentDocument` / `lastDocument` (single hit, or the title the answer named) → persist `lastContentQuestion` → `search_document` fetches by that id (cache aliased if fetch returns a different canonical id) → `chunksFromFetchPayload` → `retrieveDocumentChunks` (enrich short queries from the **same** document only) → ranked evidence to Scout → if Scout is empty / `NO_RESULTS` but chunks exist, extractive synthesis. `none` is true only when the document has no usable chunks.

## B. Real reasons Q&A returned NO_RESULTS after a search hit

Found in code, not guessed from tenant titles:

1. **document_id never persisted.** Company search returns `{ results: [...] }`. `documentFromToolResult` looks for top-level `id`/`title`, so a successful search did not become `currentDocument` unless Scout also called fetch. The next “what’s the main point?” had no current file, searched again with a useless short query, and died.
2. **Short follow-up ranking used filler words.** `what exactly?` → term `exactly` (not a stop word) → no chunk scored ≥ 1 → empty `chunks` array even when the file was indexed. `none` was `false` with empty chunks, which Scout treated as no evidence.
3. **Enrichment decayed on arrival.** After a find, `currentScope` is `COMPANY_KNOWLEDGE`. The follow-up is `CURRENT_DOCUMENT`. `scopeChanged` was true, so enrichment was skipped. The previous content question was not reused.
4. **`lastUserQuestion` overwritten by “when?” / “more?”.** The next short follow-up enriched from another short follow-up, not the find/topic.
5. **Scout weaker than the policy completer.** Usable chunks could still yield confidence `none` or `NONE_IN_DOCUMENT_REPLY`. `polishIntelligenceReply` then forced the no-results line even when chunks existed.
6. **`runGroundedQa` did not enrich.** Recovery/extractive used the raw short question, so `confidenceFromEvidence` required “exactly” to appear in the file.
7. Empty fetch / preview-only / tenant filter remain possible on live connectors. Those are SEARCH/INDEX facts, not invented. This pass does not rebuild search.

Not the cause when search already returned a titled hit: OAuth, Xero, Action Engine, or a missing LLM provider.

## C. Short follow-up enrichment

`CURRENT_DOCUMENT` / `RECENT_ENTITY` with fewer than two **content** terms (fillers like exactly / main / points stripped) reuses `lastContentQuestion` + distinctive title tokens from the **same** document. Global `GLOBAL_SEARCH_MIN_SCORE` is unchanged.

## D. Reset

Enrichment and `lastContentQuestion` reset immediately on document switch, “forget that” / subject shift, correction, or a business-system ask (sales / Xero / mailbox). They do **not** reset merely because scope moves from company search onto the file just found.

## E. More detail

Unused chunks first. If nothing new, extractive says so. Does not repeat the same excerpt.

## F. Sequences (20 per tenant)

Same 9-turn shape both sides: search → direct Q&A → short follow-up → more detail → source → unrelated → search other docs → switch → return. Subjects only from `{primary}` / `{alt}` (Caddington fallback: staff handbook / health and safety policy; Elvex fallback: service agreement / site inspection report). No Van Policy / CV 2015 / Coal Search / Elvex-specific titles. No invented expected facts — structural scoring only.

Transport this pass: **OFFLINE** (policy completer + mocked tools with two fixture bodies). **GATED** persist against live D1/connectors was not executed here. **REAL META** (`wamid.HBg…`) was not used. No unsolicited WhatsApp. William was not messaged. Caddington UAT remains Dan Hold `+447932609444`. Elvex persist identity remains Ella Mae if authorised.

## G. Before / after (honest)

| Metric | Live before (operator report, not re-measured here) | After this pass |
| --- | --- | --- |
| Search | Often works | Unchanged architecture |
| Source URL | Generally works | Unchanged |
| Switch | Generally works | Unchanged detection; enrichment now resets |
| Q&A after a hit | Can `NO_RESULTS` | Offline: 80/80 search+Q&A turns kept a `document_id` and did not emit `NONE_IN_DOCUMENT_REPLY` |
| Short follow-up | Can `NO_RESULTS` | Offline: 40/40 not `none` / not `NONE_IN_DOCUMENT_REPLY` |
| Chunk hit rate | Not previously instrumented live | Offline: 152/360 turns returned usable chunks (many turns are source / thanks / index and correctly do not retrieve) |
| Wrong-document rate | Not instrumented live | Offline heuristic flagged 20/40 switches — **noisy**: Elvex `{alt}` titles do not match the fixture alt detector, so this is not a live wrong-file rate |
| Repeated-answer rate | Live complaint | Offline more-detail: 40/40 replies matched the previous policy-completer line (one fixture chunk). Extractive more-detail unit test does **not** repeat when unused text is gone |
| Hallucination | Must not rise | Offline sequences: 0 |
| Live Scout both tenants | Weaker than offline 99.2 | **Not re-measured on Meta or persist Scout this pass** |

Do not read the 80/80 offline table as live Caddington/Elvex connector proof.

## H–I. Deploy

Not deployed. Offline gates are green (intelligence, adversarial-100, quality-v13, V5/V47, live-docqa). No live Scout improvement was measured on `api.infrastack.app`, so `wrangler deploy` was not run. Existing production versions stay as recorded on the adversarial-100 branch (`6159a776-…`, `fed669fe-…`).

## Remaining gaps

- GATED persist-inclusive 20×2 against real Caddington + Elvex indexed documents (live Scout) still required for PASS-as-live
- REAL META only with authorised UAT (Dan Hold; Ella if signed off). Do not text William
- Preview-only / empty OCR chunks still become honest no-results
- Offline more-detail under the policy completer still restates; extractive path is the live Scout fallback
- Elvex WhatsApp UAT identity is not signed off

## User action

1. Review the compare URL above.
2. When someone is watching: GATED persist batches on Caddington (Dan) and Elvex (Ella persist identity only).
3. Do not send unsolicited WhatsApp. Delete any probe key after use.
4. Deploy existing `infra-api` only after those gated conversations actually improve on both tenants.
