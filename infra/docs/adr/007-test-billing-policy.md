# ADR 007 — TEST billing policy

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 003, ADR 004, ADR 006
- **Applies to:** gateway settlement, wallets, Usage / Billing

---

## Decision

Under the current TEST configuration, a company wallet is debited only when all of the following are true:

1. The tool mapped to a **billable** pricing rule (today: `knowledge.search`, `knowledge.read` at 1p each).
2. Downstream execution **succeeded** (HTTP 200 from the company MCP).
3. The call is **not** an idempotent replay of an already-settled operation.
4. The company has sufficient prepaid credit (otherwise HTTP 402, no execution, no debit).

### Outcome matrix

| Outcome | Customer charge |
| --- | --- |
| Successful billable tool, including zero-result knowledge search | Yes (TEST 1p) |
| Successful non-billable tool (`system.health`) | No |
| `initialize` / `tools/list` | No (never reach settlement) |
| Authentication failure (401) | No |
| Permission denial (403) | No |
| Insufficient credit (402) | No |
| Downstream / INFRA internal failure | No (`chargeOnFailure` is false on TEST rules) |
| Idempotent replay of the same operation | No second charge |
| Two different tools in one interaction | Each billable success is charged |

### Zero-result searches

A successful knowledge search with no hits still used the company MCP. TEST keeps the 1p charge. This is an explicit commercial decision, not a bug.

### Idempotency

JSON-RPC `id` (including reused `0`) is **not** an idempotency key. Replay is detected from `company_id + client_request_id` (explicit header / `_meta`), or from the server-generated `request_id` when the client sent nothing.

---

## Consequences

- Implemented in `decideTestBilling()` and `executeGatewayRequest()`.
- Do not change these outcomes for live Caddington traffic without an explicit commercial decision.
- Do not activate 60% margin, Stripe, or vendor connectors in this phase.
