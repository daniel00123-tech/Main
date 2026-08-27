# Failed Request Intelligence — Weekly Review Foundation

Prepared for Part 1. **Does not auto-deploy or modify production.**

## Data already captured (structured metadata)

Usage records and audit events store:

- Company (`companyId`)
- Actor (`userId`, `actorEmail` where available)
- AI client (`sourceClient`)
- Requested action (`action`, `toolName`)
- Success/failure (`success`)
- Error metadata (`metadata.code`, `metadata.message`, etc.)
- Timestamps (`recordedAt`)
- Correlation / request IDs

The Usage page classifies failures into categories:

`AUTHENTICATION`, `PERMISSION`, `MISSING_CAPABILITY`, `VALIDATION`, `UPSTREAM_API`, `RATE_LIMIT`, `TIMEOUT`, `INSUFFICIENT_CREDIT`, `INFRA_INTERNAL`, `USER_INPUT`, `UNKNOWN`

## CSV export

Platform administrators can export filtered usage via `GET /api/commercial/usage/export` for customer billing disputes and weekly review input.

## Future weekly process (human-approved)

1. Every Sunday evening, aggregate preceding week's failed requests by category, company, integration, and action.
2. AI analysis produces a report: recurring issues, likely root cause, recommended fixes.
3. **Human/developer approval required** before any code or configuration change is deployed.

## Raw prompt retention

**Not implemented.** Deeper intent analysis would require storing raw ChatGPT/Claude prompts, which has privacy, retention, tenant isolation, and access-control implications. Document and decide before enabling.

## Commercial intelligence reuse

The same usage aggregates support:

- Highest/lowest usage customers
- Integration and AI client mix
- Failure rate per customer
- Revenue vs provider cost (where provider cost is known)

Do not fabricate missing commercial fields in UI.
