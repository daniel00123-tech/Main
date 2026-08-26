import { Hono } from "hono";
import type { Env } from "../env";
import { getMcpEnvironment } from "../services/control-plane";
import { resolveXeroMcpExecutionContext } from "../services/xero-mcp-bridge";

type AppEnv = { Bindings: Env };

const internalMcp = new Hono<AppEnv>();

/**
 * Company Business MCP calls this to obtain tenant-bound Xero credentials.
 * Authenticated via the MCP environment's auth_secret_ref Worker secret.
 * Response must never be forwarded to AI clients or logged.
 */
internalMcp.post("/api/internal/mcp/:mcpId/xero/context", async (c) => {
  const mcp = await getMcpEnvironment(c.env.DB, c.req.param("mcpId"));
  if (!mcp) return c.json({ error: "MCP environment not found" }, 404);

  const result = await resolveXeroMcpExecutionContext({
    env: c.env,
    companyId: mcp.companyId,
    mcpEnvironmentId: mcp.id,
    authHeader: c.req.header("Authorization") ?? null,
  });

  if (!result.ok) {
    return c.json(result.body, result.status);
  }

  return c.json({
    tenantId: result.tenantId,
    apiBaseUrl: result.apiBaseUrl,
    accessToken: result.accessToken,
    instanceId: result.instanceId,
    organisationName: result.organisationName,
    grantedScopes: result.grantedScopes,
  });
});

export default internalMcp;
