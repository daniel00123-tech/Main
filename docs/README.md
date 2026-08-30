# INFRA current documentation

This directory is the **current** source of truth for INFRA.

Historical ADRs, UAT reports, and operational incident runbooks remain in [`infra/docs/`](../infra/docs/). When those files disagree with this directory, this directory wins — then verify in code.

| Document | Contents |
| --- | --- |
| [../AGENTS.md](../AGENTS.md) | Primary AI / developer entry point |
| [architecture/CURRENT_ARCHITECTURE.md](architecture/CURRENT_ARCHITECTURE.md) | What is running today |
| [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md) | Capability status |
| [DEVELOPMENT_RUNBOOK.md](DEVELOPMENT_RUNBOOK.md) | Install, D1, test, deploy commands |
| [PRODUCTION_SERVICES.md](PRODUCTION_SERVICES.md) | Workers, bindings, providers (no secret values) |
| [TENANCY_AND_SECURITY.md](TENANCY_AND_SECURITY.md) | Tenants, permissions, approvals |
| [channels/WHATSAPP.md](channels/WHATSAPP.md) | Current WhatsApp architecture |
| [quality/CONTINUOUS_QUALITY_LOOP.md](quality/CONTINUOUS_QUALITY_LOOP.md) | Quality loop implementation |
| [PROJECT_STATUS.md](PROJECT_STATUS.md) | Ready / UAT / issues / debt |
| [DECISIONS.md](DECISIONS.md) | Durable decisions |
| [TEST_MATRIX.md](TEST_MATRIX.md) | Subsystem → required tests |
| [PR_RECONCILIATION.md](PR_RECONCILIATION.md) | Recent PR / branch status |
