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
| [008](./008-company-lifecycle.md) | Company lifecycle | **Accepted** |
| [009](./009-tenant-creation.md) | Tenant creation | **Accepted** |
| [010](./010-business-mcp-onboarding.md) | Business MCP onboarding | **Accepted** |
| [011](./011-future-automated-mcp-provisioning.md) | Future automated MCP provisioning (design only) | **Accepted** |
| [012](./012-connector-framework.md) | Connector framework | **Accepted** |
| [013](./013-ai-channel-model.md) | AI channel model | **Accepted** |
| [014](./014-wallet-payment-provider.md) | Wallet / payment-provider separation | **Accepted** |
| [015](./015-xero-connector-direction.md) | Xero connector direction | **Accepted** |
| [016](./016-whatsapp-channel-direction.md) | WhatsApp channel direction | **Accepted** |
| [017](./017-reference-tenant-standard.md) | Reference Tenant Standard | **Accepted** |
| [018](./018-connector-definition-vs-instance.md) | Connector definition vs instance | **Accepted** |
| [019](./019-secret-provider.md) | Secret Provider architecture | **Accepted** |
| [020](./020-credential-lifecycle.md) | Credential lifecycle | **Accepted** |
| [021](./021-oauth-and-api-key-connectors.md) | OAuth and API-key frameworks | **Accepted** |
| [022](./022-connector-health-and-sync.md) | Connector health and sync | **Accepted** |
| [023](./023-knowledge-source-contract.md) | Knowledge source contract | **Accepted** |
| [024](./024-caddington-google-drive-lessons.md) | Google Drive as knowledge template | **Accepted** |
| [025](./025-chatgpt-company-knowledge-adaptors.md) | ChatGPT Company Knowledge adaptors | **Accepted** |
| [026](./026-production-secret-provider.md) | Production SecretProvider (envelope encryption) | **Accepted** |
| [027](./027-xero-oauth-connector.md) | Reusable Xero OAuth connector | **Accepted** |
| [028](./028-xero-full-capability-architecture.md) | Xero full capability architecture | **Accepted** |
| [029](./029-action-engine-controlled-writes.md) | Action Engine and controlled financial writes | **Accepted** |
| [030](./030-company-data-platform-warehouse.md) | Company data platform / warehouse (planning) | **Proposed** |
| [031](./031-customer-economics-and-interaction-audit.md) | Customer economics and interaction audit | **Accepted** |

**Core principle:** Company MCPs own company knowledge, business data and business capabilities. INFRA owns identity, authorisation, routing, metering, billing and audit.
