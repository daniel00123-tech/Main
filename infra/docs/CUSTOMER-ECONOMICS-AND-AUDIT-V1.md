# Customer economics, interaction audit, and WhatsApp foundation V1

Operational and commercial visibility on the existing INFRA admin portal. This is not a second analytics app.

## Customer economics

Recognised **revenue** is usage charges (`usage_records.customer_charge_cents`) from the existing wallet model.

**Cash collected** is wallet `top_up` / credited Stripe checkout amounts in the same period. It is shown separately and is not mixed into margin.

**Direct cost** only includes amounts INFRA can measure or estimate from evidence:

- Azure Document Intelligence OCR (estimated: pages × $0.0015, converted to GBP)
- AI/model rows where `cost_basis` is `actual` or `estimated`
- Stripe processing fees (estimated from published UK card rates 1.5% + 20p)
- Other usage rows with actual/estimated underlying cost

Cloudflare Workers, Queues, D1, R2, Vectorize, Microsoft Graph, email/SMS, and WhatsApp are **not attributable** in V1. Do not invent those costs.

**Platform overheads** (Magnific, Cursor, tooling) are recorded manually and are **not allocated** to customers.

Gross profit £ = recognised revenue − direct cost.  
Gross margin % = profit / revenue when revenue > 0.

User-level cost uses `user_id` / `actor_email`. If attribution is not reliable, cost stays at company level.

## Interaction history

Adapter over `interactions` + `usage_records` + `gateway_requests`. Super-admin only. Viewing a body writes `interaction_access_log` and an audit event. Secrets and `Authorization` / API-key headers are redacted.

Channels: `chatgpt_mcp`, `claude_mcp`, `portal`, `api`, `automation`, `whatsapp` (future).

## Quality loop

After a gateway request, a sampled `waitUntil` job classifies **evidence-backed** signals (failed tool, auth, connector, timeout, high latency/cost, retry). It creates or groups `quality_issues`. It never changes production code, prompts, permissions, or integrations.

## WhatsApp foundation

- New users require E.164 mobile numbers.
- Existing users without a number stay usable and are flagged `mobile_verification_required`.
- `resolveWhatsAppIdentity` maps a sender number to user → company → permissions, or returns no tenant data.
- Welcome copy is stored as disabled channel config only.
- Production WhatsApp messaging is **not enabled**.

Future runtime (Cursor and ChatGPT are not required on the path):

WhatsApp Business Platform → INFRA webhook → identity lookup → AI gateway → company MCP/tools/knowledge → permissions → metering → audit → response
