# Xero integration for Company Business MCP

Install `@infra/xero-core` in the company MCP Worker (e.g. `caddington-mcp`).

## Execution flow

```
ChatGPT → INFRA MCP facade → permission check → Company MCP tool → INFRA internal bridge → Xero API
```

## Internal credential bridge

Before calling Xero, fetch tenant-bound credentials from INFRA:

```
POST https://infra-api.daniel-dwyer123.workers.dev/api/internal/mcp/{mcpEnvironmentId}/xero/context
Authorization: Bearer {MCP_AUTH_TOKEN from Worker secret}
```

Response (server-to-server only — never forward to ChatGPT):

- `tenantId`
- `apiBaseUrl`
- `accessToken`
- `instanceId`
- `organisationName`
- `grantedScopes`

## Tool registration

Register read tools using names from `@infra/shared` `XERO_READ_MCP_TOOLS`.
Implement handlers with `@infra/xero-core` read functions.

Write tools are defined in contracts but must remain unreachable until INFRA enables production writes.

## Example handler sketch

```typescript
import { XeroClient, xeroReadTools } from "@infra/xero-core";

async function handleXeroSearchInvoices(args: Record<string, unknown>, context: McpContext) {
  const creds = await fetchInfraXeroContext(context);
  const client = new XeroClient({
    accessToken: creds.accessToken,
    tenantId: creds.tenantId,
  });
  return xeroReadTools.searchInvoices(client, args);
}
```

Do not store Xero tokens in the company MCP. Resolve via INFRA on each execution.
