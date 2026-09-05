# INFRA Agentic Intelligence Standard

Core principle: **Deterministic controls, probabilistic intelligence.**

## Deterministic (Cloudflare)

Identity, tenant isolation, RBAC, billing, tool execution, write/destructive controls, connector restrictions, and audit stay on the INFRA Worker. The model cannot bypass these checks. ChatGPT / MCP remains a direct tool facade.

## Agentic (OpenAI, EL + Caddington conversational path)

Intent, planning, tool choice, multi-step research, failure recovery, reasoning, synthesis, and conversation.

At the start of a normal user request the model receives a tenant/role-safe capability catalogue. It decides what evidence is required, calls permitted tools, classifies each result as SUFFICIENT / PARTIAL / INSUFFICIENT / FAILED, and tries another permitted route when the first is insufficient. Maximum six tool/planning rounds per ordinary request.

## Tenant modes

| Tenant | Conversational brain | Notes |
| --- | --- | --- |
| EL Business | `openai_primary` | WhatsApp + Portal Chat |
| Caddington | `openai_primary` | WhatsApp + Portal Chat |
| HT | unchanged / Cloudflare | Not allowlisted |

Unscoped automation and internal jobs stay Cloudflare. Provider fallback exists for OpenAI outage/timeout/invalid response only. It is continuity protection, not the normal path.

## Hard-coded routing

Phrase maps are not the primary intelligence layer. Deterministic routing remains only for RBAC, authentication, billing, tenant boundaries, destructive writes, compliance, explicit connector restrictions, and exact source-of-truth rewrites (named invoice, warehouse freshness).

## Solution memory

Successful capability sequences may be stored as tenant-safe recipes (`intelligence_solution_recipes`). Recipes are planning hints, not hard code. They must not contain private cross-tenant content. OpenAI must not rewrite or deploy production code during a customer request.

## Quality

The quality guard catches permission leaks, contradictions, unsupported numbers, false success, false denial, and missing required evidence. It must not replace a grounded OpenAI answer with canned copy.
