# MCP provisioning recommendation (next phase)

**Status:** Design recommendation — not implemented in platform hardening phase.

## Current state

- `POST /api/companies` creates D1 records: company, wallet, portal shell, AI connection shells, audit — **no Worker**
- Business MCP is registered manually via **Register existing MCP** (`POST /api/mcp-environments`)
- HT, EL, Caddington MCPs pre-exist; Company 4+ requires operator to deploy/register separately

## Options

### A. Manual registration (current — recommended near term)

| Pros | Cons |
| --- | --- |
| Proven; no mass CF API access | Slow; operator error prone |
| Full control per customer | Inconsistent naming/versioning |
| No new secrets in provisioning pipeline | Does not scale to 100+ tenants |

**Best for:** Companies 4–10, bespoke MCP variants, reference tenants.

### B. Automated isolated provisioning

| Pros | Cons |
| --- | --- |
| Repeatable onboarding | Requires CF account API token, templates, idempotency |
| One-click Company + MCP | Cost of idle Workers/D1 per tenant |
| Version-pinned Business MCP Core | Rollback/version drift complexity |

**Target flow (ADR 011):**

1. Create company (existing)
2. Provision Worker from template + D1 + secrets
3. Register `mcp_environments` row automatically
4. Run health + capability refresh
5. Leave connectors/AI to portal onboarding

## Security comparison

| Topic | Manual | Automated |
| --- | --- | --- |
| Tenant isolation | Operator responsibility | Template enforces 1:1 Worker:D1 |
| Secret handling | Named refs only in D1 | Pipeline must never log tokens |
| Blast radius | Human mistake per tenant | Bug affects all new provisions |
| INFRA privileges | Register endpoint only | CF API create/delete resources |

## Cost (conceptual)

- **Manual:** pay for MCP when customer ready; no INFRA provisioning Worker
- **Automated:** N Workers + N D1s + optional R2/Vectorize; monitor idle cost at 10/100 tenants

## Maintenance

- **Manual:** upgrade each MCP Worker independently
- **Automated:** need `business_mcp_core_version`, staged rollout, per-tenant rollback

## Recommendation

1. **Phase next (Companies 4–10):** stay on **manual registration**; improve runbooks, health, and attention model (this hardening phase).
2. **Phase after:** build **automated provisioning** behind platform-admin feature flag when:
   - Business MCP Core template is stable
   - CF API credentials scoped to provisioning service only
   - Cost model accepted for idle tenants
3. **Do not** auto-provision until acceptance test proves isolated D1 + secret refs for one greenfield tenant.

## Activation checklist (future)

- [ ] ADR 011 implementation PR approved
- [ ] Provisioning Worker/service account with least privilege
- [ ] Idempotent create + rollback on partial failure
- [ ] No phantom MCP rows without reachable endpoint
- [ ] Audit: `mcp.provisioned` with company binding

See also [ADR 011](../adr/011-future-automated-mcp-provisioning.md), [new company onboarding](./new-company-onboarding.md).
