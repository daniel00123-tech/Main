# INFRA superstack v2 — production last-wins report

Date: 1 September 2026  
Branch: `cursor/infra-production-superstack-v2-2026-09-01-d3d8`  
Tip: `7542194`  
Compare: https://github.com/daniel00123-tech/Main/compare/main...cursor/infra-production-superstack-v2-2026-09-01-d3d8  
Run: https://cursor.com/agents/bc-1e9d191a-50d7-54ab-a5a6-afff1da025d6

## A. Git start

Fetched `origin`. Started from current `origin/main` (`60af937` Keep ChatGPT OAuth login on the portal origin, #401). Did **not** reset main to a WhatsApp-only tip.

Required ancestors present on this branch:

| SHA | Present |
|---|---|
| `4db9b0f` Sync EL portal connector state | yes |
| `d22faaf` INFRA-native MCP user OAuth | yes |
| `70892a0` Proxy INFRA OAuth through the portal | yes |

## B. Reconciled PRs / tips

Union onto this branch (capability completeness + Director Xero + this pass):

- #409–#418 quality / WhatsApp / adversarial-100
- #416 Outlook reads
- #417 invite lifecycle
- #419–#421 / #424 / #427 Elvex Xero + ChatGPT tools/list
- #422 live-docqa (included — persist id, short follow-ups, extractive Q&A)
- #423 portal chat
- #425 ChatGPT Outlook get + document Q&A
- #426 catalogue listing (open; catalogue tool already in this tree)
- Later production-relevant: intended-role persist (`5a8c0b2`), enforce cron (`de6e221`), knowledge contract (`c410e14`), EL file routing (`7542194`)

Conflicts resolved as unions (relative `/oauth/authorize` + portal-origin continue). No partial feature branch was deployed.

## C. Feature matrix vs live (before this job’s last deploy)

Parallel last-wins was real. After earlier `c39cffaa` (this job), production was overwritten to Workers **without** health lineage (`0e96a3d6`, then `471b0a17`, then `a9554839`). Portal Chat Send went **404** on those overwrites. This job waited until no `wrangler deploy` was in flight, then redeployed **this superstack last**.

## D. William — recorded before tests

Live D1 `infra-control-plane` `adacb84d-7ee8-4b27-87ff-3d554b563d71`:

| Field | Value |
|---|---|
| user_id | `user_b0db1fc5-692c-436d-99e6-392966b20df8` |
| membership_id | `membership_78495c59-cff6-4db5-9986-a351ebe154f1` |
| company_id | `co_el` |
| email | william@elvexpropertyservices.com |
| **role at job start** | **director** (`2026-09-01 20:12:41`) |
| custom_role_id | null |
| status | active |

Effective perms are code-derived (`ELVEX_ROLE_GRANTS`). Director includes `xero.sales.read`. Office staff does not. Never `platform_admin`.

## E. Must-fix implementations in this tree

1. **Deploy guard** — `assert-capability-completeness.mjs` (17 markers). `npm run deploy` refuses if markers absent.
2. **Health lineage** — official `CF_VERSION_METADATA`; `/health` returns `versionId` when bound.
3. **Portal Chat Send** — `POST /api/companies/:slug/chat/messages` in the Worker. Unauth is 401 when this tree is live (404 only after overwrite).
4. **Xero tools/list** — Director sees advertised Xero reads; execution via `el-business-mcp`. office_staff: no Xero tools; `permission_denied` / `user_not_authorised`; no knowledge fallback.
5. **Elvex document contract** — `documentRef`+`id` (+ title retry); unwrap `file.name`, `page_content`, `files[]`; skip empty Untitled chunk hits.
6. **Elvex file routing (this pass)** — `search_elvex_files` / `get_elvex_file` mapped to `knowledge.search` / `knowledge.read` (were high_risk `mcp.*` and denied even for Director). Standard `search`/`fetch`/`ask_document`/`list_company_documents` use those EL tools when advertised.
7. **Catalogue** — newest=`created_at`, latest=`modified_at`; Elvex falls through to EL file search when INFRA `microsoft_knowledge_items` is empty (Elvex count = 0 in D1).
8. **Short follow-ups** — #422+#425 in tree (`retrieveDocumentChunks`, `lastContentQuestion`, extractive fallback).

## F. Portal Chat

Live unauth `POST /api/companies/el-business/chat/messages` on this Worker: **401** `Authentication required` (route present).  
UI: `/portal/:companySlug/chat`. Pages: `1df302c0` / https://1df302c0.infra-web.pages.dev (alias `https://cursor-infra-production-supe.infra-web.pages.dev`).  
`_redirects` unchanged: `/* /index.html 200`.

## G. Xero — Director (authorised READ, no writes)

Via `https://api.infrastack.app/api/gateway/v1/mcp`. Source `el-business-mcp`. Tool `xero_sales_summary` today `fromDate/toDate=2026-09-01`:

- `summary.totalSales=-114`, `transactionCount=1`, currency GBP
- organisation “Elvex Property Services Ltd”
- monthToDate invoicedSales `-114` / 1 document
- previousMonth `-1876` / 8 documents
- No Xero write executed

## H. Xero — office_staff deny

Temporary elevation only to `office_staff` (minimum deny role), never platform_admin.

- tools/list: **no** `xero_*` / `search_xero_*`
- `xero_sales_summary` → JSON-RPC `-32003`, `permission_denied`, `reason=user_not_authorised`, `userRole=office_staff`, `connected=true`
- No automation/knowledge fallback
- OAuth refresh still minted after denial

## I. Elvex get_knowledge_document / fetch contract

Code: `toStandardFetchPayload` / `toStandardSearchPayload` + EL file tool routing.  
Live: `search` / `search_elvex_files` “staff handbook” → **200, 0 results** (not 403; not Untitled). That query has no visible hit.  
Do not invent a handbook title.

## J. Catalogue (latest from metadata)

**Elvex Director live** `list_company_documents` sort=`latest`: **200, 10 documents**, first title **`Elvex Jobs.xlsx`**, note “Sorted by provider modified_at (latest changed).”  
A later list in the same session returned 0 (EL MCP empty that call) — reported honestly.

**Caddington D1** (same SQL the tool uses; Elvex has 0 INFRA Microsoft rows):

- Newest by `created_at`: `RemittanceAdvice_11737_47489_7897.pdf` (OneDrive)
- Latest by `modified_at`: `Invoice-DLEZINKG-0001.pdf` (SharePoint)
- Counts: OneDrive 10, SharePoint 5, Outlook-shared 10 (Outlook excluded from file catalogue)

Different newest vs latest order — metadata sort is real.

## K. Short follow-ups / current-doc Q&A

In tree from #422+#425. Offline gates previously green. **20 live WhatsApp sequences per tenant were not sent** (no unsolicited WhatsApp). Live Elvex semantic search for “staff handbook” had no hit, so current-doc Q&A was not exercised on that title.

## L. Combined tests (local)

Passed: deploy guard 17 markers; `elvex-files-el-mcp`; `mcp-knowledge-standard`; `mcp-facade`; `mcp-company-knowledge`; `document-catalogue`; `elvex-xero-el-mcp`; `ask-document`; `operator-intended-role`.

## M. Deploy (one superstack, last-wins)

Authorised deployer for this job. Concurrent `wrangler deploy` checked before each upload. Other agents overwrote earlier versions; **this tree was redeployed last**.

| When (UTC) | Version | Note |
|---|---|---|
| 20:23:26 | `c39cffaa-…` | earlier this-job deploy (overwritten) |
| 20:29–20:39 | several others | overwrites; portal 404; some no `versionId` |
| 20:43:43 | `2fc0dc77-…` | this-job deploy (later overwritten) |
| 20:47:57 | `72b12085-…` | concurrent overwrite, no `versionId` |
| **20:49:24** | **`70f553e0-8cee-4d8d-933e-6e232c6f2624`** | **current last-wins 100%** |

Git tip at deploy: `5c8da6f` (Worker code unchanged from `7542194`). Worker `infra-api` only. No new Worker.

## N. Health lineage

Live: `{"status":"ok","environment":"production","versionId":"70f553e0-8cee-4d8d-933e-6e232c6f2624"}`  
Official Cloudflare `CF_VERSION_METADATA` only.

## O. Live probe (this Worker)

Recorded in `infra/docs/superstack-v2-live-probe.json` (re-run after last deploy). Public: health lineage, portal 401, webhook 403, OAuth issuer `https://api.infrastack.app`. Director Xero + catalogue + office_staff deny + restore as above.

## P. Outlook

Director `outlook_list_messages` info@ → Graph id `AAMkAGY1MTVlZjkx…AABQgcltAAA=`.  
`outlook_get_message` used **that same id**. `hasBody=true`, `via` present.  
Draft/send remain unadvertised / `TOOL_NOT_EXPOSED` / Action Engine Xero-scoped — **not faked**.

## Q. RBAC / invites / quality / usage

Invite lifecycle (#417) and quality mobile tap targets remain in the tree. Usage: Xero authorised path is existing zero-charge read; office_staff Xero is `permission_denied` (no charge path). Action Engine not weakened.

## R. WhatsApp

Webhook unchanged: `https://api.infrastack.app/api/webhooks/whatsapp` (GET without hub → 403 `Invalid verification request`). No unsolicited WhatsApp sent. Scout + 8B-fast only.

## S. OAuth / ChatGPT

Metadata live on `https://api.infrastack.app`. Client `oauth_16c41fc5-c625-4c00-9ff1-a252a28ec518`. Redirect `https://chatgpt.com/connector/oauth/callback`. Tokens + refresh minted before and after office_staff denial.

## T. Constraints held

- infra-api + infra-web only; Cursor not runtime
- No OpenAI / Anthropic / Gemini
- FAST_LOCAL / INTELLIGENT / CONTROLLED_ACTION; scope before tools
- No invented URLs/counts except measured values above
- No phrase-patches; no secret rotation
- No Xero write; no email send; no unsolicited WhatsApp
- Action Engine not weakened
- Outlook draft/send not faked

## U. William — after

| When | Role |
|---|---|
| Job start | director |
| Temp (deny only) | office_staff |
| Concurrent agents also flipped him mid-job | office_staff at times |
| **Final D1** | **director** (`2026-09-01 20:49:33`) |
| Intended persist | director (`membership_operator_roles`) |

## V. `xero.sales.read`

| When | Has `xero.sales.read` |
|---|---|
| Before | yes (director) |
| Temp office_staff | no |
| After | yes (director) |

## W. ChatGPT refresh / reconnect needed?

**No.** Refresh tokens minted after denial. Same OAuth client. `chatgptRefreshNeeded=false`.

## X. Git represents this production Worker

Branch tip `5c8da6f` (Worker code `7542194`) is the tree deployed as `70f553e0`. Contains main + reconciled PRs + Elvex file routing. Not a WhatsApp-only tip.

## Y. PR

ManagePullRequest unavailable in this runtime. Open compare / `gh pr create` to **main**:

https://github.com/daniel00123-tech/Main/compare/main...cursor/infra-production-superstack-v2-2026-09-01-d3d8

## Z. Concurrent agents

`bc-6b1b7a34` (capability completeness) stayed RUNNING and deployed/overwrote and switched the shared checkout. Director Xero `bc-92937dc2` was not in the later RUNNING list. This job is the only authorised production deployer for this request; superstack was put back last.

## AA. Remaining gaps

1. Semantic `search` “staff handbook” is honestly empty — no live current-doc Q&A on that title.
2. 20 live WhatsApp Q&A sequences per tenant not sent (constraint).
3. Elvex has **0** rows in INFRA `microsoft_knowledge_items`; catalogue depends on EL MCP file tools (one live list returned 10; a later list returned 0).
4. Other agents can still overwrite after this report if they deploy again.

## AB. Pass standard

| Gate | Status |
|---|---|
| One Worker: WhatsApp webhook + ChatGPT OAuth + Portal Chat Send | PASS on `70f553e0` |
| RBAC + invites + quality + usage in tree | PASS |
| Elvex Outlook list + full get (same id, body) | PASS |
| Elvex Xero reads (Director, EL MCP) | PASS |
| office_staff Xero deny, no fallback | PASS |
| Catalogue latest metadata | PASS (Elvex live 10 + Caddington SQL) |
| Elvex knowledge Q&A after a titled search hit | PARTIAL (contract + catalogue; handbook search empty) |
| Short follow-ups in tree | PASS (code); live sequences not sent |
| No overwrite at verify time | PASS (`70f553e0` last-wins after concurrent overwrite) |
| William original role | PASS director |
| Git represents production | PASS `5c8da6f` / Worker `7542194` |

## AC. Human-only action

Merge the compare/PR to `main` if you want git `main` to match this live Worker. Nothing else.

## AD. Pages

https://1df302c0.infra-web.pages.dev — portal chat route in this build.

## AE. Elvex file tools

`search_elvex_files` / `get_elvex_file` are advertised and now authorised as knowledge reads (Director and office_staff). Before this pass they were `high_risk` and Director got `permission_denied`.

## AF. Deploy guard

17 source markers including `executeElvexKnowledgeViaElFiles` and `CF_VERSION_METADATA`.

## AG. Action Engine

Unchanged. `plan_xero_*` / confirm / execute remain mediated. No Xero write from this job.

## AH. Outlook draft/send

Not implemented. Not advertised as working. Not faked.

## AI. Measured figures only

Elvex sales today: `totalSales=-114`, 1 transaction, 1 Sep 2026. Catalogue first title when non-empty: `Elvex Jobs.xlsx`. No other document titles invented.

## AJ. Environment

D1 `infra-control-plane` `adacb84d-7ee8-4b27-87ff-3d554b563d71`. EL MCP binding `EL_BUSINESS_MCP`. Webhook `https://api.infrastack.app/api/webhooks/whatsapp`.

## AK. Write-out for ChatGPT paste

See the following section in the agent reply.

## AL. Verdict

**PASS** on Worker `70f553e0-8cee-4d8d-933e-6e232c6f2624` for WhatsApp + ChatGPT OAuth + Portal Chat Send + RBAC + Elvex Xero reads + Outlook list/get + catalogue + deploy guard + William restored to Director. Elvex semantic handbook Q&A remains empty-corpus, not a 403/Untitled contract failure.
