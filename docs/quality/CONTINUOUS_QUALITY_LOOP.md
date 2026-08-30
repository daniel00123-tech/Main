# Continuous Quality Loop

Implementation: `infra/packages/api/src/services/quality-loop/`.
Evaluator version: `quality-loop-whatsapp-v1`.
Channel actually evaluated: **WhatsApp only**.

Do not copy old prompts. This matches the code on this branch.

## Purpose

Review real WhatsApp conversations, score them, propose bounded runtime improvements, and apply only low-risk patches after admin approval and replay validation. High-risk or engineering changes are recorded, never auto-deployed.

## Cadence

From `cadence.ts`:

| Phase | When | Window |
| --- | --- | --- |
| Daily | First **60 days** after `activatedAt` | 08:00 Europe/London, minute &lt; 15, previous complete London day |
| Weekly | After day 60 | Friday 08:00 Europe/London, previous complete London week |

Cron on `infra-api` is `*/15 * * * *`. `maybeRunQualityLoop` no-ops outside the window and skips a period already stored on the config row.

A **baseline** run executes once if `baselineCompletedAt` is missing (all history up to now).

Manual / forced kinds exist for operators (`daily`, `weekly`, `baseline`) via the quality-loop routes.

## Evaluator

`evaluator.ts` scores a `ConversationThread` on:

`completeness`, `latency`, `grounding`, `context`, `tool_correctness`, `permission_safety`, `ux`, `reliability`.

Threads are rebuilt from audit / usage / WhatsApp lifecycle — not from ChatGPT conversation export.

Failure flags (negative) include silence, stuck, context loss, raw dump, missing source URL, excessive latency, wrong tool, permission UX problems, voice failure, connector error, greeting slow, outbound Meta failure.

Positive flags include correct permission denial, thanks, follow-up used, first tool correct, fast response.

`assertTenantIsolation` is required before scoring.

## Failure detection and patterns

`patterns.ts` groups repeat flags into fingerprints so the same silence or missing-source issue becomes one proposal, not one per turn.

## Proposals

`proposals.ts` emits a `QualityProposalDraft`:

| Kind | Typical risk | Auto-applyable? |
| --- | --- | --- |
| `prompt_tweak`, `planner_config`, `response_rule`, `threshold`, `ranking`, `suggested_actions`, `guidance_behaviour` | low / medium | yes if patch paths are safe |
| `engineering_change` | high | **never** |

`HIGH_RISK_PROPOSAL_KEYS`: `auth`, `permission(s)`, `tenant`, `isolation`, `financial`, `billing`, `action_engine`, `secret`, `oauth`, `write`.

A patch that disables `blockWriteIntents` is refused.

## Admin review and approval

- Admin UI: Quality Issues / Quality Improvements pages
- Email: review token (24h TTL) to configured recipients (`quality-loop/email.ts`)
- `decideProposal` / `approveRecommended` in `runner.ts`
- Company portal users do not promote platform runtime

## Testing before apply

`replay.ts` + `validateBeforePromote`:

- Replay the WhatsApp planner UAT fixture against the patched runtime
- Any UAT failure → do not promote
- `blockWriteIntents === false` → do not promote

## Deployment boundaries

`apply.ts`:

1. High-risk / `engineeringRequired` / not `autoApplyable` → status `approved`, **report-only**, no production apply
2. Safe patches → new runtime version, **canary** (Caddington-weighted via `shouldUseCanaryRuntime`)
3. WhatsApp orchestrator reads `resolveActiveWhatsAppRuntime` per turn
4. Canary either promotes or rolls back (`canaryShouldRollback`, `promoteOrRollbackCanary`)

The loop **never** deploys Worker code, Wrangler changes, or secret changes. Those stay human engineering PRs.

## Rollback

Automatic if canary metrics trip `canaryShouldRollback`. Operator email via `qualityRollbackEmail`. Previous promoted runtime remains the default.

## Risk classifications

| Risk | Meaning |
| --- | --- |
| low | Prompt / threshold / ranking / guidance; auto-applyable after approval + UAT |
| medium | Planner/response rules that still pass the safe-path regex |
| high | Auth, permissions, tenancy, financial, billing, Action Engine, secrets, OAuth, writes — report only |

## What this is not

- Not a ChatGPT/Claude evaluator (types allow those channels; runner does not)
- Not a replacement for unit tests or Meta UAT
- Not allowed to weaken tenant isolation or write gates
