import { Hono } from "hono";
import type { ToolAction } from "@infra/shared";
import { CONNECTOR_CATALOGUE } from "@infra/shared";
import {
  clearSessionCookie,
  requireAuth,
  requirePlatformAdmin,
  setSessionCookie,
} from "./auth/middleware";
import {
  createSessionToken,
} from "./auth/session";
import {
  bootstrapPlatformAdminIfNeeded,
  getUserByEmail,
  getUserById,
  listUsers,
  toSessionUser,
  updateUserPassword,
} from "./auth/users";
import {
  consumeSetupToken,
  findValidSetupToken,
  maskEmail,
  validateNewPassword,
} from "./auth/password-setup";
import { createCorsMiddleware } from "./cors";
import type { Env } from "./env";
import {
  evaluateActionPermission,
  listRolePresets,
  userHasCompanyAccess,
} from "./permissions/service";
import {
  ensureDefaultToolAllowlist,
  executeRegisteredMcpTool,
  getCompanyById,
  getCompanyBySlug,
  getCompanyOverview,
  getConnectorInstance,
  getCreditBalance,
  getMcpEnvironment,
  getPlatformSummary,
  listAuditEvents,
  listCompanies,
  listConnectorInstances,
  listMcpEnvironments,
  listSyncHistory,
  recordAuditEvent,
  runMcpHealthCheck,
} from "./services/control-plane";
import { getUsageSummary, listUsageRecords } from "./services/usage";
import { listMcpTools } from "./services/mcp-client";
import { verifyPassword } from "./auth/password";

const app = new Hono<{ Bindings: Env }>();

app.use("*", createCorsMiddleware());

app.use("*", async (c, next) => {
  await bootstrapPlatformAdminIfNeeded(
    c.env.DB,
    c.env.INITIAL_PLATFORM_ADMIN_EMAIL,
    c.env.INITIAL_PLATFORM_ADMIN_PASSWORD,
  );
  await next();
});

app.get("/", (c) =>
  c.json({
    name: "INFRA",
    description: "Administration and control platform for business AI infrastructure",
    version: "0.1.0",
    role: "control_plane",
  }),
);

app.get("/health", (c) =>
  c.json({
    status: "ok",
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
  }),
);

app.get("/api/auth/password-setup/validate", async (c) => {
  const token = c.req.query("token");
  if (!token) {
    return c.json({ valid: false, error: "Setup token is required" }, 400);
  }

  const record = await findValidSetupToken(c.env.DB, token);
  if (!record) {
    return c.json({ valid: false, error: "Invalid or expired setup token" }, 400);
  }

  const user = await getUserById(c.env.DB, record.userId);
  if (!user || user.status !== "active") {
    return c.json({ valid: false, error: "Invalid or expired setup token" }, 400);
  }

  return c.json({
    valid: true,
    maskedEmail: maskEmail(user.email),
    expiresAt: record.expiresAt,
    purpose: record.purpose,
  });
});

app.post("/api/auth/password-setup", async (c) => {
  const body = await c.req.json<{
    token?: string;
    password?: string;
    confirmPassword?: string;
  }>();

  if (!body.token || !body.password || !body.confirmPassword) {
    return c.json({ error: "Token, password, and confirmation are required" }, 400);
  }

  if (body.password !== body.confirmPassword) {
    return c.json({ error: "Passwords do not match" }, 400);
  }

  const passwordError = validateNewPassword(body.password);
  if (passwordError) {
    return c.json({ error: passwordError }, 400);
  }

  const record = await findValidSetupToken(c.env.DB, body.token);
  if (!record) {
    await recordAuditEvent(c.env.DB, {
      eventType: "auth.password_setup_failed",
      actor: "unknown",
      detail: { reason: "invalid_or_expired_token" },
    });
    return c.json({ error: "Invalid or expired setup token" }, 400);
  }

  const user = await getUserById(c.env.DB, record.userId);
  if (!user || user.status !== "active") {
    await recordAuditEvent(c.env.DB, {
      eventType: "auth.password_setup_failed",
      actor: "unknown",
      detail: { reason: "invalid_user", tokenId: record.id },
    });
    return c.json({ error: "Invalid or expired setup token" }, 400);
  }

  await updateUserPassword(c.env.DB, user.id, body.password);
  await consumeSetupToken(c.env.DB, record.id);

  await recordAuditEvent(c.env.DB, {
    eventType: "auth.password_setup_completed",
    actor: user.email,
    resourceType: "user",
    resourceId: user.id,
    detail: {
      purpose: record.purpose,
      tokenId: record.id,
    },
  });

  return c.json({ ok: true });
});

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  if (!body.email || !body.password) {
    return c.json({ error: "Email and password are required" }, 400);
  }

  const user = await getUserByEmail(c.env.DB, body.email);
  if (!user || user.status !== "active") {
    await recordAuditEvent(c.env.DB, {
      eventType: "auth.login_failed",
      actor: body.email,
      detail: { reason: "unknown_user" },
    });
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const valid = await verifyPassword(
    body.password,
    user.passwordSalt,
    user.passwordHash,
  );
  if (!valid) {
    await recordAuditEvent(c.env.DB, {
      eventType: "auth.login_failed",
      actor: body.email,
      detail: { reason: "invalid_password" },
    });
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const sessionUser = await toSessionUser(c.env.DB, user);
  const token = await createSessionToken(sessionUser, c.env.SESSION_SECRET);
  setSessionCookie(c, token);

  await recordAuditEvent(c.env.DB, {
    eventType: "auth.login",
    actor: user.email,
    detail: { userId: user.id },
  });

  return c.json(sessionUser);
});

app.post("/api/auth/logout", requireAuth, async (c) => {
  const user = c.get("user");
  clearSessionCookie(c);
  await recordAuditEvent(c.env.DB, {
    eventType: "auth.logout",
    actor: user.email,
    detail: { userId: user.userId },
  });
  return c.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, (c) => c.json(c.get("user")));

app.get("/api/summary", requireAuth, async (c) => {
  const user = c.get("user");
  const companyIds = user.isPlatformAdmin
    ? undefined
    : user.memberships.map((membership) => membership.companyId);
  const summary = await getPlatformSummary(c.env.DB, companyIds);
  return c.json(summary);
});

app.get("/api/connectors/catalogue", requireAuth, (c) =>
  c.json(CONNECTOR_CATALOGUE),
);

app.get("/api/connectors/catalogue/:slug", requireAuth, (c) => {
  const connector = CONNECTOR_CATALOGUE.find((item) => item.slug === c.req.param("slug"));
  if (!connector) return c.json({ error: "Connector not found" }, 404);
  return c.json(connector);
});

app.get("/api/companies", requireAuth, async (c) => {
  const user = c.get("user");
  const companyIds = user.isPlatformAdmin
    ? undefined
    : user.memberships.map((membership) => membership.companyId);
  const companies = await listCompanies(c.env.DB, companyIds);
  return c.json(companies);
});

app.get("/api/companies/:slug", requireAuth, async (c) => {
  const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);

  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "permission.denied",
      actor: c.get("user").email,
      resourceType: "company",
      resourceId: company.id,
      detail: { route: "GET /api/companies/:slug" },
    });
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: "company.accessed",
    actor: c.get("user").email,
    resourceType: "company",
    resourceId: company.id,
  });

  return c.json(company);
});

app.get("/api/companies/:slug/overview", requireAuth, async (c) => {
  const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);

  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "permission.denied",
      actor: c.get("user").email,
      resourceType: "company",
      resourceId: company.id,
      detail: { route: "GET /api/companies/:slug/overview" },
    });
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  const overview = await getCompanyOverview(c.env.DB, company.id);
  return c.json(overview);
});

app.get("/api/mcp-environments", requireAuth, async (c) => {
  const user = c.get("user");
  const requestedCompanyId = c.req.query("companyId");

  if (requestedCompanyId && !userHasCompanyAccess(user, requestedCompanyId)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  const companyId = requestedCompanyId
    ? requestedCompanyId
    : user.isPlatformAdmin
      ? undefined
      : user.memberships[0]?.companyId;

  if (!user.isPlatformAdmin && !companyId) {
    return c.json([]);
  }

  const environments = await listMcpEnvironments(c.env.DB, companyId);
  if (!user.isPlatformAdmin && companyId) {
    return c.json(environments.filter((item) => item.companyId === companyId));
  }

  if (!user.isPlatformAdmin) {
    const allowed = new Set(user.memberships.map((membership) => membership.companyId));
    return c.json(environments.filter((item) => allowed.has(item.companyId)));
  }

  return c.json(environments);
});

app.get("/api/mcp-environments/:id", requireAuth, async (c) => {
  const environment = await getMcpEnvironment(c.env.DB, c.req.param("id"));
  if (!environment) return c.json({ error: "MCP environment not found" }, 404);

  if (!userHasCompanyAccess(c.get("user"), environment.companyId)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  return c.json(environment);
});

app.post("/api/mcp-environments/:id/health-check", requireAuth, async (c) => {
  const environment = await getMcpEnvironment(c.env.DB, c.req.param("id"));
  if (!environment) return c.json({ error: "MCP environment not found" }, 404);

  if (!userHasCompanyAccess(c.get("user"), environment.companyId)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  const result = await runMcpHealthCheck(
    c.env,
    c.req.param("id"),
    c.get("user").email,
  );
  if (!result) return c.json({ error: "MCP environment not found" }, 404);
  return c.json(result);
});

app.get(
  "/api/mcp-environments/:id/allowed-tools",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    const environment = await getMcpEnvironment(c.env.DB, c.req.param("id"));
    if (!environment) return c.json({ error: "MCP environment not found" }, 404);

    await ensureDefaultToolAllowlist(
      c.env.DB,
      environment.companyId,
      environment.id,
    );

    const rows = await c.env.DB.prepare(
      `SELECT tool_name, risk_class, enabled FROM mcp_tool_allowlist
       WHERE mcp_environment_id = ? AND enabled = 1
       ORDER BY tool_name ASC`,
    )
      .bind(environment.id)
      .all();

    return c.json(
      (rows.results ?? []).map((row) => ({
        toolName: String(row.tool_name),
        riskClass: String(row.risk_class),
        enabled: Boolean(row.enabled),
      })),
    );
  },
);

app.post(
  "/api/mcp-environments/:id/execute",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    const environment = await getMcpEnvironment(c.env.DB, c.req.param("id"));
    if (!environment) return c.json({ error: "MCP environment not found" }, 404);

    const body = await c.req.json<{
      toolName?: string;
      arguments?: Record<string, unknown>;
    }>();

    if (!body.toolName || typeof body.toolName !== "string") {
      return c.json({ error: "toolName is required" }, 400);
    }

    const user = c.get("user");
    const result = await executeRegisteredMcpTool(c.env, {
      mcpId: environment.id,
      toolName: body.toolName,
      arguments: body.arguments,
      actorUserId: user.userId,
      actorEmail: user.email,
      sourceClient: "infra-admin-test",
    });

    if (result.status !== 200) {
      return c.json(
        {
          error: result.error,
          correlationId:
            "correlationId" in result ? result.correlationId : undefined,
        },
        result.status,
      );
    }

    return c.json(result.data);
  },
);

app.get(
  "/api/mcp-environments/:id/remote-tools",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    const environment = await getMcpEnvironment(c.env.DB, c.req.param("id"));
    if (!environment) return c.json({ error: "MCP environment not found" }, 404);

    try {
      const tools = await listMcpTools(
        c.env,
        environment.endpointUrl,
        environment.authSecretRef,
      );
      await recordAuditEvent(c.env.DB, {
        companyId: environment.companyId,
        eventType: "mcp.tools_listed",
        actor: c.get("user").email,
        resourceType: "mcp",
        resourceId: environment.id,
        detail: { toolCount: tools.tools.length },
      });
      return c.json({
        tools: tools.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? null,
        })),
        latencyMs: tools.latencyMs,
        authConfigured: tools.authConfigured,
      });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to list MCP tools",
        },
        502,
      );
    }
  },
);

app.get("/api/companies/:slug/usage", requireAuth, async (c) => {
  const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);

  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "permission.denied",
      actor: c.get("user").email,
      resourceType: "usage",
      resourceId: company.id,
      detail: { route: "GET /api/companies/:slug/usage" },
    });
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  const limit = Number(c.req.query("limit") ?? "50");
  const [records, summary] = await Promise.all([
    listUsageRecords(c.env.DB, company.id, limit),
    getUsageSummary(c.env.DB, company.id),
  ]);

  return c.json({ companyId: company.id, summary, records });
});

app.get("/api/companies/:slug/usage/summary", requireAuth, async (c) => {
  const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);

  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  const summary = await getUsageSummary(c.env.DB, company.id);
  return c.json(summary);
});

app.get("/api/connector-instances", requireAuth, async (c) => {
  const user = c.get("user");
  const requestedCompanyId = c.req.query("companyId");

  if (requestedCompanyId && !userHasCompanyAccess(user, requestedCompanyId)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  const companyId = requestedCompanyId
    ? requestedCompanyId
    : user.isPlatformAdmin
      ? undefined
      : user.memberships[0]?.companyId;

  const instances = await listConnectorInstances(c.env.DB, companyId);

  if (!user.isPlatformAdmin) {
    const allowed = new Set(user.memberships.map((membership) => membership.companyId));
    return c.json(instances.filter((item) => allowed.has(item.companyId)));
  }

  return c.json(instances);
});

app.get("/api/connector-instances/:id", requireAuth, async (c) => {
  const instance = await getConnectorInstance(c.env.DB, c.req.param("id"));
  if (!instance) return c.json({ error: "Connector instance not found" }, 404);

  if (!userHasCompanyAccess(c.get("user"), instance.companyId)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  return c.json(instance);
});

app.get("/api/connector-instances/:id/sync-history", requireAuth, async (c) => {
  const instance = await getConnectorInstance(c.env.DB, c.req.param("id"));
  if (!instance) return c.json({ error: "Connector instance not found" }, 404);

  if (!userHasCompanyAccess(c.get("user"), instance.companyId)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  const history = await listSyncHistory(c.env.DB, instance.id);
  return c.json(history);
});

app.get("/api/audit-events", requireAuth, async (c) => {
  const user = c.get("user");
  const requestedCompanyId = c.req.query("companyId");
  const limit = Number(c.req.query("limit") ?? "20");

  if (requestedCompanyId && !userHasCompanyAccess(user, requestedCompanyId)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  const companyId = requestedCompanyId
    ? requestedCompanyId
    : user.isPlatformAdmin
      ? undefined
      : user.memberships[0]?.companyId;

  const events = await listAuditEvents(c.env.DB, companyId, limit);

  if (!user.isPlatformAdmin) {
    const allowed = new Set(user.memberships.map((membership) => membership.companyId));
    return c.json(events.filter((event) => !event.companyId || allowed.has(event.companyId)));
  }

  return c.json(events);
});

app.get("/api/companies/:id/credit-balance", requireAuth, async (c) => {
  const company = await getCompanyById(c.env.DB, c.req.param("id"));
  if (!company) return c.json({ error: "Company not found" }, 404);

  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  const balance = await getCreditBalance(c.env.DB, company.id);
  return c.json(balance ?? { companyId: company.id, balanceCents: 0, currency: "GBP" });
});

app.get("/api/users", requireAuth, async (c) => {
  const user = c.get("user");
  const requestedCompanyId = c.req.query("companyId");

  if (requestedCompanyId && !userHasCompanyAccess(user, requestedCompanyId)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  if (!user.isPlatformAdmin && !requestedCompanyId) {
    return c.json({ error: "Company scope is required" }, 403);
  }

  const users = await listUsers(
    c.env.DB,
    user.isPlatformAdmin ? requestedCompanyId : requestedCompanyId ?? user.memberships[0]?.companyId,
  );
  return c.json(users);
});

app.get("/api/roles/presets", requireAuth, (c) => c.json(listRolePresets()));

app.post("/api/permissions/check", requireAuth, async (c) => {
  const body = await c.req.json<{ companyId?: string; action?: ToolAction }>();
  if (!body.companyId || !body.action) {
    return c.json({ error: "companyId and action are required" }, 400);
  }

  const decision = await evaluateActionPermission(
    c.env.DB,
    c.get("user"),
    body.companyId,
    body.action,
  );

  if (!decision.allowed) {
    await recordAuditEvent(c.env.DB, {
      companyId: body.companyId,
      eventType: "permission.denied",
      actor: c.get("user").email,
      resourceType: "action",
      resourceId: body.action,
      detail: { reason: decision.reason, riskClass: decision.riskClass },
    });
  }

  return c.json(decision);
});

export default app;
