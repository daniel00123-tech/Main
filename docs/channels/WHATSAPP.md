# WhatsApp — current architecture

This is the **only** current WhatsApp document. Do not treat V1 / V2 / V3 / V4 PR branches as competing instructions. Those were stacked deliveries; this branch contains the V4.2 tip.

Implementation root: `infra/packages/api/src/services/whatsapp-*.ts` and `infra/packages/api/src/routes/whatsapp.ts`.

## Current path

```
WhatsApp user
  → Meta Cloud API
  → GET/POST /api/webhooks/whatsapp on infra-api
  → X-Hub-Signature-256 (META_APP_SECRET)
  → persist inbound event (fail-open; signature rejects also persisted)
  → greeting / thanks fast-lane (optional immediate reply, before queue/MCP)
  → enqueue WHATSAPP_INBOUND_QUEUE
  → independent 10s / 30s watchdog messages
  → consumer: identity → conversational brain → MCP/tools → Meta reply
```

`WHATSAPP_OUTBOUND_AI_ENABLED` must be `true` for AI replies (set in production wrangler vars).

Cursor is not in this path. ChatGPT is not required.

## Meta webhook

- Verify: `GET /api/webhooks/whatsapp` (`hub.mode`, `hub.verify_token`, `hub.challenge`)
- Inbound: `POST /api/webhooks/whatsapp`
- Secrets: `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `META_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`
- Vars: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`
- Canonical URL: `https://api.infrastack.app/api/webhooks/whatsapp`

If the production signature secret is missing, the webhook returns 503 after persisting the miss.

## Queue

Queue: `whatsapp-inbound` (DLQ `whatsapp-inbound-dlq`), `max_batch_size = 1`.

The HTTP handler acks Meta immediately. It does **not** dual-run the full consumer on the same isolate when the queue accepted the job (that caused CLAIM_BUSY / DLQ). In-request processing is only the fallback when enqueue fails.

Watchdogs are separate queue messages (`stage: t10` / `t30`), not a 30s await on the consumer.

## Identity

`resolveWhatsAppIdentity`: E.164 → user → memberships → role.

Unknown number: no tenant data; public copy only.

Multi-company users are asked to choose a company. Permissions then follow that company.

## Conversational brain

`whatsapp-orchestrator.ts` + `whatsapp-plan.ts`:

1. Load conversation context + entity memory
2. Resolve quality-loop runtime config (promoted or canary)
3. Classify intent (greeting/thanks/cheap conversational vs tool work vs write)
4. Cheap intents can skip MCP (fast-lane also covers greeting/thanks at the webhook)
5. Otherwise plan tools (knowledge search/fetch, Xero reads, outlook reads, capability replies)
6. Execute via the same gateway path as MCP (permissions, wallet, audit)
7. Compress / synthesise a short WhatsApp reply
8. Optional source URL when the user asked or a document hit has one
9. Send text and/or interactive buttons/lists
10. Stamp lifecycle + schedule quality audit

## Entity memory

`whatsapp-entities.ts` + conversation store (`0041_whatsapp_conversations`). Follow-ups can reuse recent document titles / facts without re-searching when the planner says so.

## Read / typing / acknowledgements

`whatsapp-realtime.ts` + latency marks:

- Mark read / typing where Meta allows
- Fast acknowledgement on slow turns
- Progress update after a delay
- 1.5s first-response failsafe on the V4.2 path
- Avoid burying a later `hi` behind a 31s queue hold (V4.2)

## Interactive replies

`whatsapp-buttons.ts` + send helpers: reply buttons and list messages for company pick, suggested actions, and “open source” style follow-ups. Button context must stay in conversation memory (quality flags `button_context_lost`).

## Source links

`whatsapp-source-urls.ts` looks up a real source URL from the knowledge document. Do not invent URLs. Quality loop scores `missing_source_url` when the user asked and none was sent.

## Voice transcription

`whatsapp-transcribe.ts` + `whatsapp-media.ts`:

1. Workers AI Whisper (`AI` binding) — preferred
2. Optional `OPENAI_API_KEY` fallback
3. Transcript becomes the turn text; failures get a clear user message (`voice_failure` quality flag)

## Permission behaviour

Denied tools return `permissionBlockedWhatsAppMessage` — no raw dumps, no other-tenant data. Correct denials are a **positive** quality signal (`permission_denial_correct`).

## Write approvals

Planner `blockWriteIntents` is on. Write-looking WhatsApp turns get `writeIntentWhatsAppMessage` and must go through portal Action Engine. Quality-loop auto-apply cannot turn this off.

## Watchdog and reaper

- Queue watchdogs at 10s / 30s (`whatsapp-watchdog.ts`)
- Cron `*/15` runs `sweepStuckWhatsAppTurns` (`whatsapp-reaper.ts`)
- Lifecycle stamps (`whatsapp-lifecycle.ts`) make silent turns visible in D1

## Quality telemetry

Non-blocking `scheduleQualityAudit` plus Continuous Quality Loop (WhatsApp evaluator). See [../quality/CONTINUOUS_QUALITY_LOOP.md](../quality/CONTINUOUS_QUALITY_LOOP.md).

## Remaining live issues

- **Live Meta inbound UAT outstanding.** V4.2 was written because some `hi` messages never created a D1 inbound row / `wamid.HBg…`. A real message from the linked phone is still the proof.
- Connector catalogue row for WhatsApp is still `coming_soon` / `isAvailable: false` — catalogue lag, not a second architecture.
- Welcome template and verification SMS are **not** enabled (`WHATSAPP_FOUNDATION_CONSTRAINTS`).

## Change history (not competing specs)

| Label | What landed | Keep as history only |
| --- | --- | --- |
| V1 | Identity, economics/interactions foundation, channel reservation | #368 |
| Webhook / activation | Meta verify, queue, outbound flag | #370–#371, #376 |
| UX / latency | Ack, typing, never-silent intent | #378 |
| V2 brain | Entity memory, source links, dynamic tools | #379 |
| V3 | Never-silent UX, source URL backfill, 75-prompt UAT harness | #380 |
| V4 | Friendlier tone, interactive replies, voice notes | #381 |
| Quality loop | Daily/weekly evaluator + proposals | #382 |
| V4.1 | Silent-path forensics, greeting fix | #384 |
| **V4.2 (current)** | Persist fail-open, greeting fast-lane, independent watchdog, no dual-run | **#386 / this branch** |
