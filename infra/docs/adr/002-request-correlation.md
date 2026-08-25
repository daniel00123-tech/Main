# ADR 002 — Request / interaction correlation

- **Status:** Accepted
- **Date:** 2026-08-24
- **Depends on:** ADR 001
- **Applies to:** INFRA gateway, MCP facade, usage, ledger, Usage UI

---

## Context

One human ChatGPT turn can call several company tools (typically Knowledge Search then Knowledge Read). Those operations are recorded separately and currently each attract the TEST 1p customer charge.

JSON-RPC `id` cannot group them. ChatGPT reuses `id=0` across unrelated calls. Using that value as an idempotency or grouping key previously collapsed distinct searches into a body-less replay (`{}`).

We need a durable grouping concept so a later customer view can show:

```
AI Knowledge Request      £0.02
  ├ Knowledge Search      £0.01
  └ Knowledge Read        £0.01
```

…without changing tonight’s TEST prices or rewriting historical rows.

---

## Decision

INFRA generates and stores **server-side** identifiers:

| Field | Meaning |
| --- | --- |
| `interaction_id` | One human AI turn / conversation action. Client may supply `X-Infra-Interaction-Id` or `params._meta.interactionId`. If absent, INFRA generates `int_…` **per operation**. We do **not** guess that nearby calls belong together. |
| `parent_request_id` | Optional link from a child operation to a parent INFRA request. |
| `mcp_session_id` | Transport session (`Mcp-Session-Id`). Not an interaction group. |
| `correlation_id` | Per-operation INFRA correlation (`corr_…`). |
| `request_id` / `client_request_id` | Idempotency for a single tool invocation. Never derived from JSON-RPC `id=0`. |

Rules:

1. Never treat `"0"` as an identifier.
2. Never infer groups from prompt text or time proximity.
3. Do not backfill historical `usage_records` into guessed groups.
4. Keep granular operation rows. Customer aggregation is a **presentation** concern on rows that already share `interaction_id`.
5. TEST 1p per operation remains until commercial pricing is approved.

---

## Correlation strategy (authoritative)

1. Read optional `X-Infra-Interaction-Id`, then `params._meta.interactionId`, then `params.interactionId`.
2. Accept a client value for **grouping** only when it matches `int_[A-Za-z0-9_-]{6,128}`. Other strings are stored as metadata and a server `int_…` is generated.
3. Reject `"0"` and empty / oversized values. JSON-RPC `id` is never read.
4. If nothing trustworthy is supplied, generate a fresh `int_…` **per operation**.
5. Never group by prompt text, company slug, MCP id, or time proximity.
6. If we cannot know that two calls belong to one human prompt, leave them separate.

## Limitations

ChatGPT and Claude do **not** currently send a shared interaction identifier. Until they do (or INFRA adds a session helper that the client forwards), a typical Knowledge Search + Knowledge Read pair appears as two generated interactions. That is honest. Guessing would merge concurrent users.

`Mcp-Session-Id` is a transport session, not an interaction. One session can contain many unrelated prompts.

## Consequences

- Columns on `usage_records` and `gateway_requests` (migration 0009).
- First-class `interactions` rollup (migration 0010) — totals only, no guessed backfill.
- Usage UI may show an expandable group **only** when multiple rows share the same `interaction_id`.
- See ADR 006 for the interaction → operation → cost-component hierarchy.
