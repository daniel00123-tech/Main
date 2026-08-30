import { Hono } from "hono";
import type { Env } from "../env";
import { getCompanyById, getCompanyBySlug, getMcpEnvironment } from "../services/control-plane";
import { resolveXeroMcpExecutionContext } from "../services/xero-mcp-bridge";
import { authenticateCompanyMcpCaller, recordCompanyMcpUsage } from "../services/mcp-oauth/usage-report";
import { introspectPayload, resolveMcpUserFromBearer } from "../services/mcp-oauth/resolve-actor";
import { verifyInfraMcpAccessToken } from "../services/mcp-oauth/tokens";

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

/**
 * Generic live membership check for company MCP workers.
 * Auth: company MCP transport token or INFRA_MCP_INTERNAL_SECRET.
 */
internalMcp.post("/api/internal/mcp/introspect", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    token?: string;
    companyId?: string;
    companySlug?: string;
  };
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return c.json({ active: false, reason: "token required" }, 400);

  const claims = await verifyInfraMcpAccessToken(c.env, token, c.req.url);
  const company =
    (body.companyId ? await getCompanyById(c.env.DB, body.companyId) : null) ??
    (body.companySlug ? await getCompanyBySlug(c.env.DB, body.companySlug) : null) ??
    (claims ? await getCompanyById(c.env.DB, claims.company_id) : null);
  if (!company) return c.json({ active: false, reason: "unknown_company" }, 404);

  const caller = await authenticateCompanyMcpCaller(c.env, c.req.raw, company.id);
  if (!caller.ok) return c.json({ active: false, reason: caller.error }, caller.status);

  const resolved = await resolveMcpUserFromBearer(c.env, token, c.req.url);
  if (resolved.ok && resolved.value.companyId !== company.id) {
    return c.json({ active: false, reason: "company_mismatch" }, 403);
  }
  return c.json(introspectPayload(resolved, claims));
});

/**
 * Generic usage attribution for company-MCP-direct traffic (EL, HT, Caddington).
 * Preferred path is still the INFRA gateway, which records usage natively.
 */
internalMcp.post("/api/internal/mcp/usage", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    companyId?: string;
    companySlug?: string;
    userId?: string;
    actorEmail?: string;
    sourceClient?: string;
    toolName?: string;
    connector?: string;
    success?: boolean;
    durationMs?: number;
    correlationId?: string;
    requestId?: string;
    mcpEnvironmentId?: string;
    metadata?: Record<string, unknown>;
  };
  const company =
    (body.companyId ? await getCompanyById(c.env.DB, body.companyId) : null) ??
    (body.companySlug ? await getCompanyBySlug(c.env.DB, body.companySlug) : null);
  if (!company) return c.json({ error: "Company not found" }, 404);

  const caller = await authenticateCompanyMcpCaller(c.env, c.req.raw, company.id);
  if (!caller.ok) return c.json({ error: caller.error }, caller.status);
  if (!body.toolName?.trim()) return c.json({ error: "toolName is required" }, 400);

  const recorded = await recordCompanyMcpUsage(c.env, {
    companyId: company.id,
    userId: body.userId,
    actorEmail: body.actorEmail,
    sourceClient: body.sourceClient,
    toolName: body.toolName.trim(),
    connector: body.connector,
    success: body.success !== false,
    durationMs: body.durationMs,
    correlationId: body.correlationId,
    requestId: body.requestId,
    mcpEnvironmentId: body.mcpEnvironmentId ?? caller.mcpId,
    metadata: body.metadata,
  });
  if (!recorded.ok) return c.json({ error: recorded.error }, 400);
  return c.json({ ok: true, usageId: recorded.usage.id, alreadyExists: recorded.usage.alreadyExists });
});

export default internalMcp;
