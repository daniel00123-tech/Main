# Company Teams — permission inheritance (Part 1 foundation)

## Purpose

Teams group users within a company (Finance, Operations, Engineering) with shared baseline access.

## Precedence (evaluate in order)

1. **Platform policy** — suspended company, financial write gates
2. **User exception** — explicit deny/allow on a user (future)
3. **Team baseline** — permissions granted to the team (future)
4. **Role preset** — Engineer, Office Staff, Director, etc.
5. **Company default** — deny by default for unlisted actions

## Part 1 status

- Schema/API for custom teams is **deferred to Part 2**
- Role presets remain the authoritative permission bundles
- Portal Team page handles user invite and role assignment today

## Security

All enforcement remains server-side via `evaluateActionPermission` and MCP scope checks.
