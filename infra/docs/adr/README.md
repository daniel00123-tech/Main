# Architecture Decision Records (ADRs)

Authoritative decisions that future INFRA / Business MCP work must follow.

| ADR | Title | Status |
| --- | --- | --- |
| [001](./001-company-mcp-vs-infra-boundary.md) | Company MCP vs INFRA boundary | **Accepted** |
| [002](./002-request-correlation.md) | Request / interaction correlation | **Accepted** |
| [003](./003-pricing-margin-vs-markup.md) | Pricing: cost, charge, margin vs markup | **Accepted** |
| [004](./004-wallet-stripe-preparation.md) | Wallet ledger and Stripe preparation | **Accepted** |
| [005](./005-action-classification-and-approvals.md) | Action classification and future approvals | **Accepted** |
| [006](./006-three-level-metering.md) | Three-level metering model | **Accepted** |
| [007](./007-test-billing-policy.md) | TEST billing policy | **Accepted** |

**Core principle:** Company MCPs own company knowledge, business data and business capabilities. INFRA owns identity, authorisation, routing, metering, billing and audit.
