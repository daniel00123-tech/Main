import { Hono } from "hono";
import type { ToolAction, CompanyRole } from "@infra/shared";
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
  createMembership,
  getUserByEmail,
  getUserById,
  listUsers,
  recordUserLogin,
  toSessionUser,
  updateUserPassword,
} from "./auth/users";
import {
  provisionCompany,
  setCompanyLifecycleStatus,
  getCompanyByPortalHostname,
  getCompanyByPortalSubdomain,
} from "./services/tenant-provisioning";
import { portalOrigin } from "./services/public-urls";
import { queueEmail, renderPasswordResetEmail } from "./services/email-outbox";
import {
  attachExistingCompanyMcp,
  EXISTING_PRODUCTION_COMPANY_MCPS,
  registerExistingMcpEnvironment,
} from "./services/register-existing-mcp";
import {
  consumeSetupToken,
  createPasswordSetupToken,
  findValidSetupToken,
  maskEmail,
  validateNewPassword,
} from "./auth/password-setup";
import { createCorsMiddleware } from "./cors";
import type { Env } from "./env";
import {
  evaluateActionPermission,
  getUserCompanyRole,
  isRolePermissionEditable,
  listRoleActionOverrides,
  listRolePresets,
  replaceCompanyRoleOverrides,
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
import { getSpendThisMonthCents } from "./services/wallet-metrics";
import { groupOperationsIntoInteractions } from "./services/interactions";
import { listMcpTools } from "./services/mcp-client";
import { verifyPassword } from "./auth/password";
import phase3Routes from "./routes/phase3";
import connectorRoutes from "./routes/connectors";
import internalMcpRoutes from "./routes/internal-mcp";
import actionPlanRoutes from "./routes/action-plans";

const app = new Hono<{ Bindings: Env }>();

app.use("*", createCorsMiddleware());

app.route("/", phase3Routes);
app.route("/", connectorRoutes);
app.route("/", internalMcpRoutes);
app.route("/", actionPlanRoutes);

app.use("*", async (c, next) => {
  await bootstrapPlatformAdminIfNeeded(
    c.env.DB,
    c.env.INITIAL_PLATFORM_ADMIN_EMAIL,
    c.env.INITIAL_PLATFORM_ADMIN_PASSWORD,
  );
  const { ensureDefaultPricing } = await import("./services/pricing");
  await ensureDefaultPricing(c.env.DB);
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

app.get("/ready", async (c) => {
  try {
    const row = await c.env.DB.prepare("SELECT 1 AS ok").first();
    if (!row) {
      return c.json(
        {
          status: "not_ready",
          checks: { d1: "empty" },
          timestamp: new Date().toISOString(),
        },
        503,
      );
    }
    return c.json({
      status: "ready",
      checks: { d1: "ok" },
      timestamp: new Date().toISOString(),
    });
  } catch {
    return c.json(
      {
        status: "not_ready",
        checks: { d1: "error" },
        timestamp: new Date().toISOString(),
      },
      503,
    );
  }
});

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

app.post("/api/auth/password-reset/request", async (c) => {
  const body = await c.req.json<{ email?: string }>();
  const email = body.email?.trim().toLowerCase();
  if (!email) {
    return c.json({ error: "Email is required" }, 400);
  }

  const genericMessage =
    "If an account exists for that email, use the secure link to set a new password. Links expire after one hour.";

  const user = await getUserByEmail(c.env.DB, email);
  if (!user || user.status !== "active") {
    await recordAuditEvent(c.env.DB, {
      eventType: "auth.password_reset_requested",
      actor: email,
      detail: { outcome: "no_account" },
    });
    return c.json({ ok: true, message: genericMessage });
  }

  const { token, expiresAt } = await createPasswordSetupToken(
    c.env.DB,
    user.id,
    "password_reset",
  );
  const origin = portalOrigin(c.env, c.req.header("Origin"));
  const resetUrl = `${origin}/setup-password?token=${encodeURIComponent(token)}`;

  const emailContent = renderPasswordResetEmail({
    setupUrl: resetUrl,
    expiresAt: new Date(expiresAt).toLocaleString("en-GB"),
  });
  const emailResult = await queueEmail(c.env, c.env.DB, {
    toEmail: user.email,
    templateKey: "password_reset",
    subject: emailContent.subject,
    bodyText: emailContent.text,
    bodyHtml: emailContent.html,
  });

  await recordAuditEvent(c.env.DB, {
    eventType: "auth.password_reset_requested",
    actor: user.email,
    resourceType: "user",
    resourceId: user.id,
    detail: { outcome: "link_created", expiresAt, emailSent: emailResult.sent },
  });

  return c.json({
    ok: true,
    message: genericMessage,
    emailSent: emailResult.sent,
    ...(emailResult.sent ? {} : { resetUrl, expiresAt }),
  });
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
  await recordUserLogin(c.env.DB, user.id);

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

app.get("/api/auth/me", requireAuth, async (c) => {
  // Reload memberships from DB so portal access is not stuck on a stale JWT
  // (e.g. membership created after the current login).
  const session = c.get("user");
  const dbUser = await getUserById(c.env.DB, session.userId);
  if (!dbUser || dbUser.status !== "active") {
    clearSessionCookie(c);
    return c.json({ error: "Invalid or expired session" }, 401);
  }
  const fresh = await toSessionUser(c.env.DB, dbUser);
  const token = await createSessionToken(fresh, c.env.SESSION_SECRET);
  setSessionCookie(c, token);
  return c.json(fresh);
});

app.get("/api/summary", requireAuth, async (c) => {
  const user = c.get("user");
  const companyIds = user.isPlatformAdmin
    ? undefined
    : user.memberships.map((membership) => membership.companyId);
  const summary = await getPlatformSummary(c.env.DB, companyIds);
  return c.json(summary);
});

app.get("/api/platform/attention", requireAuth, async (c) => {
  const user = c.get("user");
  if (!user.isPlatformAdmin) {
    return c.json({ error: "Platform administrator access required" }, 403);
  }
  const { buildPlatformAttention, filterAttentionDismissals } = await import("./services/attention");
  const { isStripeConfigured } = await import("./services/stripe");
  const items = await filterAttentionDismissals(
    c.env.DB,
    await buildPlatformAttention(c.env.DB, {
      stripeConfigured: isStripeConfigured(c.env),
    }),
    c.get("user").email,
  );
  return c.json({ items, checkedAt: new Date().toISOString() });
});

app.post("/api/platform/attention/dismiss", requireAuth, requirePlatformAdmin, async (c) => {
  const body = await c.req.json<{ attentionKey?: string; severity?: string; snoozeUntil?: string | null }>();
  if (!body.attentionKey || !body.severity) {
    return c.json({ error: "attentionKey and severity required" }, 400);
  }
  const { dismissAttentionItem } = await import("./services/attention");
  const result = await dismissAttentionItem(c.env.DB, {
    attentionKey: body.attentionKey,
    severity: body.severity as "critical" | "warning" | "info",
    actor: c.get("user").email,
    snoozeUntil: body.snoozeUntil ?? null,
  });
  if (!result.ok) return c.json({ error: result.message, code: result.code }, 409);
  return c.json({ ok: true });
});

app.get("/api/companies/admin-directory", requireAuth, requirePlatformAdmin, async (c) => {
  const { listCompaniesAdminDirectory } = await import("./services/companies-admin");
  return c.json(await listCompaniesAdminDirectory(c.env.DB));
});

app.get("/api/companies/:slug/attention", requireAuth, async (c) => {
  const slug = c.req.param("slug");
  const company = await getCompanyBySlug(c.env.DB, slug);
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!userHasCompanyAccess(c.get("user"), company.id) && !c.get("user").isPlatformAdmin) {
    return c.json({ error: "Access denied" }, 403);
  }
  const { buildCompanyAttention } = await import("./services/attention");
  const items = await buildCompanyAttention(c.env.DB, company.id);
  return c.json({ items, checkedAt: new Date().toISOString() });
});

app.get("/api/connectors/catalogue/:slug", requireAuth, (c) => {
  const connector = CONNECTOR_CATALOGUE.find((item) => item.slug === c.req.param("slug"));
  if (!connector) return c.json({ error: "Connector not found" }, 404);
  return c.json(connector);
});

app.get("/api/companies/slug-availability", requireAuth, requirePlatformAdmin, async (c) => {
  const raw = c.req.query("slug") ?? "";
  const { validateCompanySlug } = await import("@infra/shared");
  const checked = validateCompanySlug(raw);
  if (!checked.ok) {
    return c.json({ available: false, slug: raw, error: checked.error });
  }
  const existing = await getCompanyBySlug(c.env.DB, checked.slug);
  return c.json({
    available: !existing,
    slug: checked.slug,
    error: existing ? "Slug is already in use" : null,
  });
});

app.get("/api/companies", requireAuth, async (c) => {
  const user = c.get("user");
  const companyIds = user.isPlatformAdmin
    ? undefined
    : user.memberships.map((membership) => membership.companyId);
  const companies = await listCompanies(c.env.DB, companyIds, {
    query: c.req.query("q") ?? undefined,
    status: c.req.query("status") ?? undefined,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    offset: c.req.query("offset") ? Number(c.req.query("offset")) : undefined,
  });
  return c.json(companies);
});

app.post("/api/mcp-environments", requireAuth, requirePlatformAdmin, async (c) => {
  const body = await c.req.json<{
    companyId?: string;
    companySlug?: string;
    name?: string;
    description?: string;
    endpointUrl?: string;
    authSecretRef?: string;
    serviceBindingRef?: string;
    dataPlaneId?: string;
    mcpVersion?: string;
    coreVersion?: string;
  }>();
  const company = body.companyId
    ? await getCompanyById(c.env.DB, body.companyId)
    : body.companySlug
      ? await getCompanyBySlug(c.env.DB, body.companySlug)
      : null;
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!body.name || !body.endpointUrl || !body.authSecretRef) {
    return c.json(
      { error: "name, endpointUrl and authSecretRef are required" },
      400,
    );
  }
  try {
    const mcp = await registerExistingMcpEnvironment(c.env.DB, {
      companyId: company.id,
      name: body.name,
      description: body.description,
      endpointUrl: body.endpointUrl,
      authSecretRef: body.authSecretRef,
      serviceBindingRef: body.serviceBindingRef,
      dataPlaneId: body.dataPlaneId,
      mcpVersion: body.mcpVersion,
      coreVersion: body.coreVersion,
      actor: c.get("user").email,
      environment: c.env.ENVIRONMENT,
    });
    return c.json(mcp, 201);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Unable to register MCP" },
      400,
    );
  }
});

app.post(
  "/api/admin/onboard-existing-company-mcps",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    const actor = c.get("user");
    const attached = [];
    for (const spec of EXISTING_PRODUCTION_COMPANY_MCPS) {
      const result = await attachExistingCompanyMcp(c.env.DB, spec, actor.email);
      const existingMembership = await c.env.DB
        .prepare(
          `SELECT id FROM company_memberships WHERE user_id = ? AND company_id = ?`,
        )
        .bind(actor.userId, result.company.id)
        .first();
      if (!existingMembership) {
        await createMembership(c.env.DB, {
          userId: actor.userId,
          companyId: result.company.id,
          role: "company_admin",
        });
      }
      attached.push({
        companyId: result.company.id,
        slug: result.company.slug,
        mcpId: result.mcp.id,
        endpointUrl: result.mcp.endpointUrl,
        authSecretRef: result.mcp.authSecretRef,
      });
    }
    return c.json({ attached });
  },
);

app.post("/api/companies", requireAuth, requirePlatformAdmin, async (c) => {
  const body = await c.req.json<import("@infra/shared").CreateCompanyInput>();
  try {
    const result = await provisionCompany(c.env.DB, body, c.get("user").email, {
      portalBaseDomain:
        typeof c.env.PORTAL_BASE_DOMAIN === "string"
          ? c.env.PORTAL_BASE_DOMAIN
          : "infra-web.pages.dev",
    });
    return c.json(
      {
        company: result.company,
        portalPath: `/portal/${result.company.slug}/dashboard`,
        portalHostname: result.company.portalHostname,
        adminInvite: result.adminInvite
          ? {
              email: result.adminInvite.email,
              setupUrl: `${portalOrigin(c.env, c.req.header("Origin"))}/setup-password?token=${encodeURIComponent(result.adminInvite.setupToken)}`,
              expiresAt: result.adminInvite.expiresAt,
            }
          : null,
      },
      201,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unable to create company";
    return c.json({ error: message }, 400);
  }
});

app.post(
  "/api/companies/:slug/status",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    const body = await c.req.json<{
      status?: "onboarding" | "active" | "suspended" | "archived" | "closed";
      reason?: string;
    }>();
    if (
      !body.status ||
      !["onboarding", "active", "suspended", "archived", "closed"].includes(
        body.status,
      )
    ) {
      return c.json(
        { error: "status must be onboarding, active, suspended, archived, or closed" },
        400,
      );
    }
    const updated = await setCompanyLifecycleStatus(
      c.env.DB,
      company.id,
      body.status,
      c.get("user").email,
      body.reason?.trim(),
    );
    return c.json(updated);
  },
);

app.delete("/api/companies/:slug", requireAuth, requirePlatformAdmin, async (c) => {
  const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  const { deleteCompanyIfSafe } = await import("./services/tenant-provisioning");
  const result = await deleteCompanyIfSafe(c.env.DB, company.id, c.get("user").email);
  if (!result.ok) return c.json({ error: result.message, code: result.code }, 409);
  return c.json({ ok: true });
});

app.get("/api/portal/resolve", requireAuth, async (c) => {
  const host = c.req.query("host")?.trim();
  const slug = c.req.query("slug")?.trim();
  const subdomain = c.req.query("subdomain")?.trim();
  let company = null;
  if (slug) company = await getCompanyBySlug(c.env.DB, slug);
  else if (subdomain) company = await getCompanyByPortalSubdomain(c.env.DB, subdomain);
  else if (host) company = await getCompanyByPortalHostname(c.env.DB, host);
  else {
    return c.json({ error: "host, slug, or subdomain is required" }, 400);
  }
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }
  return c.json({
    company,
    portalPath: `/portal/${company.slug}/dashboard`,
  });
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

app.get("/api/companies/:slug/onboarding", requireAuth, async (c) => {
  const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }
  const overview = await getCompanyOverview(c.env.DB, company.id);
  return c.json(overview?.onboarding ?? { companyId: company.id, readyForUse: false, items: [], problems: [] });
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
        environment.serviceBindingRef,
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
  const interactions = groupOperationsIntoInteractions(records);

  return c.json({ companyId: company.id, summary, records, interactions });
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
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);

  if (requestedCompanyId && !userHasCompanyAccess(user, requestedCompanyId)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  const companyId = requestedCompanyId
    ? requestedCompanyId
    : user.isPlatformAdmin
      ? undefined
      : user.memberships[0]?.companyId;

  const events = await listAuditEvents(c.env.DB, companyId, limit, {
    eventPrefix: c.req.query("category") ?? undefined,
    from: c.req.query("from") ?? undefined,
    to: c.req.query("to") ?? undefined,
    actor: c.req.query("actor") ?? undefined,
  });

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

app.get("/api/companies/:slug/role-permissions", requireAuth, async (c) => {
  const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  const user = c.get("user");
  const role = getUserCompanyRole(user, company.id);
  const canView =
    user.isPlatformAdmin || role === "company_admin" || role === "director";
  if (!canView) {
    return c.json({ error: "Company administrator access required" }, 403);
  }
  const overrides = await listRoleActionOverrides(c.env.DB, company.id);
  const presets = listRolePresets();
  return c.json({
    companyId: company.id,
    companySlug: company.slug,
    overrides,
    editableRoles: presets
      .map((preset) => preset.role)
      .filter((r) => isRolePermissionEditable(r)),
    presets,
    canEdit: user.isPlatformAdmin || role === "company_admin" || role === "director",
  });
});

app.put("/api/companies/:slug/role-permissions", requireAuth, async (c) => {
  const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  const user = c.get("user");
  const role = getUserCompanyRole(user, company.id);
  const canEdit =
    user.isPlatformAdmin || role === "company_admin" || role === "director";
  if (!canEdit) {
    return c.json({ error: "Company administrator access required" }, 403);
  }
  const body = await c.req.json<{
    role?: CompanyRole;
    grants?: Array<{ action: ToolAction; effect: "allow" | "deny" }>;
  }>();
  if (!body.role || !Array.isArray(body.grants)) {
    return c.json({ error: "role and grants array are required" }, 400);
  }
  if (!isRolePermissionEditable(body.role)) {
    return c.json({ error: "This role cannot be modified" }, 403);
  }
  try {
    const overrides = await replaceCompanyRoleOverrides(
      c.env.DB,
      company.id,
      body.role,
      body.grants,
    );
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "role.permissions.updated",
      actor: user.email,
      resourceType: "role",
      resourceId: body.role,
      detail: { grantCount: body.grants.length },
    });
    return c.json({ ok: true, overrides });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Unable to save permissions" },
      400,
    );
  }
});

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

const worker = {
  fetch: app.fetch.bind(app),
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const { runMicrosoftScheduledSync } = await import("./services/microsoft-scheduler");
    await runMicrosoftScheduledSync(env);
  },
  async queue(batch: MessageBatch<import("./services/microsoft-queue").MicrosoftFileJobMessage>, env: Env) {
    const { processMicrosoftFileJob, MICROSOFT_KNOWLEDGE_INGEST_DLQ } = await import(
      "./services/microsoft-queue"
    );
    const isDeadLetter = batch.queue === MICROSOFT_KNOWLEDGE_INGEST_DLQ;
    for (const message of batch.messages) {
      try {
        await processMicrosoftFileJob(env, message.body, { deadLetter: isDeadLetter });
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
};

export { app };

export default worker;
