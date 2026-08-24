import { Hono } from "hono";
import type { CompanyRole } from "@infra/shared";
import type { Env } from "../env";
import {
  requireAuth,
  requirePlatformAdmin,
  type AuthVariables,
} from "../auth/middleware";
import { readSessionCookie, verifySessionToken } from "../auth/session";
import {
  getUserById,
  inviteCompanyUser,
  setMembershipStatus,
  setUserStatus,
  updateMembershipRole,
} from "../auth/users";
import {
  getCompanyBySlug,
  listMcpEnvironments,
  recordAuditEvent,
} from "../services/control-plane";
import {
  executeGatewayRequest,
  resolveGatewayActor,
} from "../services/gateway";
import { handleInfraMcpHttp } from "../services/mcp-gateway";
import {
  appendLedgerEntry,
  getWalletBalance,
  listLedgerEntries,
  listPlatformBalances,
} from "../services/ledger";
import {
  ensureDefaultPricing,
  listPricingPolicies,
  listPricingRules,
} from "../services/pricing";
import {
  createManualPricingReviewProposal,
  ensureProviderCostCatalogue,
  getProviderRateCard,
  listPricingReviews,
  listProviderRateCards,
} from "../services/provider-costs";
import {
  listFinancialExceptions,
  runFinancialReconciliation,
} from "../services/reconciliation";
import {
  getUsageCommercialSummary,
  listPlatformUsage,
} from "../services/usage";
import {
  createServiceIdentity,
  listServiceIdentities,
  rotateServiceIdentityToken,
  setServiceIdentityStatus,
  getServiceIdentity,
  type ServiceIdentityType,
} from "../services/service-identities";
import {
  createTopUpCheckoutIntent,
  isStripeConfigured,
  processStripeWebhookEvent,
  verifyStripeWebhookSignature,
} from "../services/stripe";
import {
  getUserCompanyRole,
  userHasCompanyAccess,
} from "../permissions/service";
import { newId, nowIso } from "../db/mappers";

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const phase3 = new Hono<AppEnv>();

async function companyFromSlug(db: D1Database, slug: string) {
  return getCompanyBySlug(db, slug);
}

function canManageCompany(user: AuthVariables["user"], companyId: string) {
  if (user.isPlatformAdmin) return true;
  const role = getUserCompanyRole(user, companyId);
  return role === "company_admin" || role === "director";
}

// ---------- Gateway ----------

phase3.post("/api/gateway/v1/execute", async (c) => {
  const token = readSessionCookie(c.req.header("Cookie") ?? null);
  const sessionUser = token
    ? await verifySessionToken(token, c.env.SESSION_SECRET)
    : null;

  const actorResult = await resolveGatewayActor(c.env, c.req.raw, sessionUser);
  if ("error" in actorResult) {
    return c.json({ error: actorResult.error }, actorResult.status);
  }

  const body = await c.req.json<{
    companyId?: string;
    companySlug?: string;
    toolName?: string;
    arguments?: Record<string, unknown>;
    mcpEnvironmentId?: string;
    sourceClient?: string;
    clientRequestId?: string;
    requestId?: string;
  }>();

  let companyId = body.companyId;
  if (!companyId && body.companySlug) {
    const company = await getCompanyBySlug(c.env.DB, body.companySlug);
    companyId = company?.id;
  }
  if (!companyId && actorResult.type === "service") {
    companyId = actorResult.identity.companyId;
  }

  if (!companyId || !body.toolName) {
    return c.json({ error: "companyId and toolName are required" }, 400);
  }

  const result = await executeGatewayRequest(c.env, {
    actor: actorResult,
    companyId,
    toolName: body.toolName,
    arguments: body.arguments,
    mcpEnvironmentId: body.mcpEnvironmentId,
    sourceClient:
      body.sourceClient ?? c.req.header("X-Infra-Client") ?? "gateway",
    clientRequestId:
      body.clientRequestId ??
      body.requestId ??
      c.req.header("X-Infra-Request-Id") ??
      null,
  });

  if (result.status !== 200) {
    return c.json(
      {
        error: result.error,
        correlationId: result.correlationId,
        action: "action" in result ? result.action : undefined,
        riskClass: "riskClass" in result ? result.riskClass : undefined,
        balanceCents: "balanceCents" in result ? result.balanceCents : undefined,
        requiredCents:
          "requiredCents" in result ? result.requiredCents : undefined,
      },
      result.status,
    );
  }

  return c.json(result);
});

// MCP protocol facade — ChatGPT/Claude should connect here, not to company MCP directly
phase3.all("/api/gateway/v1/mcp", async (c) => {
  const token = readSessionCookie(c.req.header("Cookie") ?? null);
  const sessionUser = token
    ? await verifySessionToken(token, c.env.SESSION_SECRET)
    : null;
  return handleInfraMcpHttp(c.env, c.req.raw, sessionUser);
});

phase3.get("/api/gateway/v1/health", (c) =>
  c.json({
    status: "ok",
    service: "infra-gateway",
    version: "v1",
    stripeConfigured: isStripeConfigured(c.env),
    mcpFacade: "/api/gateway/v1/mcp",
  }),
);

// ---------- Company wallet / billing ----------

phase3.get("/api/companies/:slug/wallet", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  const [wallet, ledger] = await Promise.all([
    getWalletBalance(c.env.DB, company.id),
    listLedgerEntries(c.env.DB, company.id, 30),
  ]);

  return c.json({
    wallet,
    ledger,
    stripeConfigured: isStripeConfigured(c.env),
    topUpOptionsCents: [5000, 10000, 25000],
  });
});

phase3.post("/api/companies/:slug/wallet/top-up", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  const user = c.get("user");
  if (!canManageCompany(user, company.id)) {
    return c.json({ error: "Company administrator access required" }, 403);
  }

  const body = await c.req.json<{
    amountCents?: number;
    successUrl?: string;
    cancelUrl?: string;
  }>();

  if (!body.amountCents || body.amountCents < 500) {
    return c.json({ error: "amountCents must be at least 500 (£5)" }, 400);
  }

  const origin = c.req.header("Origin") ?? "https://infra-web.pages.dev";
  const result = await createTopUpCheckoutIntent(c.env, {
    companyId: company.id,
    amountCents: body.amountCents,
    createdBy: user.email,
    successUrl:
      body.successUrl ?? `${origin}/portal/billing?topup=success`,
    cancelUrl: body.cancelUrl ?? `${origin}/portal/billing?topup=cancelled`,
  });

  if (!result.configured && "error" in result) {
    return c.json({ error: result.error, stripeConfigured: false }, 400);
  }

  return c.json(result);
});

phase3.post(
  "/api/companies/:slug/wallet/manual-credit",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    const body = await c.req.json<{
      amountCents?: number;
      description?: string;
    }>();
    if (!body.amountCents || body.amountCents === 0) {
      return c.json({ error: "amountCents is required" }, 400);
    }

    const entry = await appendLedgerEntry(c.env.DB, {
      companyId: company.id,
      entryType: body.amountCents > 0 ? "manual_credit" : "adjustment",
      amountCents: body.amountCents,
      description: body.description ?? "Platform admin manual adjustment",
      referenceType: "manual",
      referenceId: newId("manual"),
      createdBy: c.get("user").email,
      metadata: { isTestConfig: true },
    });

    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "billing.credit_adjusted",
      actor: c.get("user").email,
      resourceType: "ledger",
      resourceId: entry.entry.id,
      detail: { amountCents: body.amountCents },
    });

    return c.json(entry);
  },
);

phase3.get("/api/billing/balances", requireAuth, requirePlatformAdmin, async (c) => {
  const balances = await listPlatformBalances(c.env.DB);
  return c.json(balances);
});

phase3.get("/api/pricing/rules", requireAuth, async (c) => {
  const companyId = c.req.query("companyId");
  if (companyId && !userHasCompanyAccess(c.get("user"), companyId)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }
  return c.json(await listPricingRules(c.env.DB, companyId));
});

// ---------- Stripe webhook ----------

phase3.post("/api/stripe/webhook", async (c) => {
  const payload = await c.req.text();
  const signature = c.req.header("Stripe-Signature");

  if (!isStripeConfigured(c.env)) {
    return c.json(
      {
        error: "Stripe is not configured",
        requiredSecrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
      },
      503,
    );
  }

  const valid = await verifyStripeWebhookSignature(
    c.env,
    payload,
    signature ?? null,
  );
  if (!valid) {
    return c.json({ error: "Invalid Stripe signature" }, 400);
  }

  const event = JSON.parse(payload) as {
    id: string;
    type: string;
    data?: unknown;
  };

  const result = await processStripeWebhookEvent(c.env, {
    stripeEventId: event.id,
    eventType: event.type,
    payload: event as unknown as Record<string, unknown>,
  });

  return c.json(result);
});

// ---------- Users / invites ----------

phase3.post("/api/companies/:slug/users/invite", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  const user = c.get("user");
  if (!canManageCompany(user, company.id)) {
    return c.json({ error: "Company administrator access required" }, 403);
  }

  const body = await c.req.json<{
    email?: string;
    displayName?: string;
    role?: CompanyRole;
  }>();

  if (!body.email || !body.displayName || !body.role) {
    return c.json({ error: "email, displayName, and role are required" }, 400);
  }

  const invited = await inviteCompanyUser(c.env.DB, {
    email: body.email,
    displayName: body.displayName,
    companyId: company.id,
    role: body.role,
  });

  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: "user.created",
    actor: user.email,
    resourceType: "user",
    resourceId: invited.user.id,
    detail: { role: body.role, created: invited.created },
  });

  const origin = c.req.header("Origin") ?? "https://infra-web.pages.dev";
  return c.json({
    user: {
      id: invited.user.id,
      email: invited.user.email,
      displayName: invited.user.displayName,
      status: invited.user.status,
    },
    role: body.role,
    setupUrl: `${origin}/setup-password?token=${encodeURIComponent(invited.setupToken)}`,
    setupTokenExpiresAt: invited.expiresAt,
    // Token returned once for admin to share securely — not stored plaintext
    setupToken: invited.setupToken,
  });
});

phase3.post("/api/companies/:slug/users/:userId/status", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  const actor = c.get("user");
  if (!canManageCompany(actor, company.id)) {
    return c.json({ error: "Company administrator access required" }, 403);
  }

  const body = await c.req.json<{ status?: "active" | "disabled" }>();
  if (!body.status) return c.json({ error: "status is required" }, 400);

  const targetId = c.req.param("userId");
  if (targetId === actor.userId) {
    return c.json({ error: "Cannot change your own status" }, 400);
  }

  await setMembershipStatus(c.env.DB, targetId, company.id, body.status);
  // Also disable platform login if membership revoked and not platform admin
  const target = await getUserById(c.env.DB, targetId);
  if (target && !target.isPlatformAdmin && body.status === "disabled") {
    await setUserStatus(c.env.DB, targetId, "disabled");
  }
  if (target && body.status === "active") {
    await setUserStatus(c.env.DB, targetId, "active");
  }

  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: body.status === "disabled" ? "user.disabled" : "role.changed",
    actor: actor.email,
    resourceType: "user",
    resourceId: targetId,
    detail: { status: body.status },
  });

  return c.json({ ok: true, userId: targetId, status: body.status });
});

phase3.post("/api/companies/:slug/users/:userId/role", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  const actor = c.get("user");
  if (!canManageCompany(actor, company.id)) {
    return c.json({ error: "Company administrator access required" }, 403);
  }

  const body = await c.req.json<{ role?: CompanyRole }>();
  if (!body.role) return c.json({ error: "role is required" }, 400);

  const membership = await updateMembershipRole(
    c.env.DB,
    c.req.param("userId"),
    company.id,
    body.role,
  );

  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: "role.changed",
    actor: actor.email,
    resourceType: "user",
    resourceId: c.req.param("userId"),
    detail: { role: body.role },
  });

  return c.json({ ok: true, membership });
});

// ---------- Service identities ----------

phase3.get("/api/companies/:slug/service-identities", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }
  return c.json(await listServiceIdentities(c.env.DB, company.id));
});

phase3.post("/api/companies/:slug/service-identities", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!canManageCompany(c.get("user"), company.id)) {
    return c.json({ error: "Company administrator access required" }, 403);
  }

  const body = await c.req.json<{
    name?: string;
    identityType?: ServiceIdentityType;
    description?: string;
    scopes?: string[];
    mcpEnvironmentId?: string;
  }>();

  if (!body.name || !body.identityType) {
    return c.json({ error: "name and identityType are required" }, 400);
  }

  const mcps = await listMcpEnvironments(c.env.DB, company.id);
  const mcpId = body.mcpEnvironmentId ?? mcps[0]?.id ?? null;

  const created = await createServiceIdentity(c.env.DB, {
    companyId: company.id,
    name: body.name,
    identityType: body.identityType,
    description: body.description,
    scopes: body.scopes,
    mcpEnvironmentId: mcpId,
  });

  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: "credential.created",
    actor: c.get("user").email,
    resourceType: "service_identity",
    resourceId: created.identity.id,
    detail: { identityType: body.identityType, tokenPrefix: created.identity.tokenPrefix },
  });

  return c.json({
    identity: created.identity,
    token: created.token,
    warning: "Store this token securely. It will not be shown again.",
  });
});

phase3.post(
  "/api/companies/:slug/service-identities/:id/rotate",
  requireAuth,
  async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }

    const identity = await getServiceIdentity(c.env.DB, c.req.param("id"));
    if (!identity || identity.companyId !== company.id) {
      return c.json({ error: "Service identity not found" }, 404);
    }

    const rotated = await rotateServiceIdentityToken(c.env.DB, identity.id);
    if (!rotated) return c.json({ error: "Rotate failed" }, 500);

    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "credential.rotated",
      actor: c.get("user").email,
      resourceType: "service_identity",
      resourceId: identity.id,
      detail: { tokenPrefix: rotated.identity.tokenPrefix },
    });

    return c.json({
      identity: rotated.identity,
      token: rotated.token,
      warning: "Store this token securely. It will not be shown again.",
    });
  },
);

phase3.post(
  "/api/companies/:slug/service-identities/:id/status",
  requireAuth,
  async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }

    const identity = await getServiceIdentity(c.env.DB, c.req.param("id"));
    if (!identity || identity.companyId !== company.id) {
      return c.json({ error: "Service identity not found" }, 404);
    }

    const body = await c.req.json<{ status?: "active" | "disabled" }>();
    if (!body.status) return c.json({ error: "status is required" }, 400);

    const updated = await setServiceIdentityStatus(
      c.env.DB,
      identity.id,
      body.status,
    );
    return c.json(updated);
  },
);

// ---------- AI client connections ----------

phase3.get("/api/companies/:slug/ai-connections", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  const rows = await c.env.DB.prepare(
    `SELECT * FROM ai_client_connections WHERE company_id = ? ORDER BY client_type ASC`,
  )
    .bind(company.id)
    .all();

  const origin = "https://infra-api.daniel-dwyer123.workers.dev";

  return c.json(
    (rows.results ?? []).map((row) => ({
      id: String(row.id),
      companyId: String(row.company_id),
      clientType: String(row.client_type),
      displayName: String(row.display_name),
      status: String(row.status),
      serviceIdentityId: row.service_identity_id
        ? String(row.service_identity_id)
        : null,
      gatewayEndpoint: `${origin}/api/gateway/v1/execute`,
      mcpEndpoint: `${origin}/api/gateway/v1/mcp`,
      gatewayPath: row.gateway_path ? String(row.gateway_path) : null,
      setupNotes: row.setup_notes ? String(row.setup_notes) : null,
      lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    })),
  );
});

phase3.post(
  "/api/companies/:slug/ai-connections/:clientType/connect",
  requireAuth,
  async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }

    const clientType = c.req.param("clientType");
    if (clientType === "whatsapp") {
      return c.json({ error: "WhatsApp is coming soon" }, 400);
    }
    if (clientType !== "chatgpt" && clientType !== "claude") {
      return c.json({ error: "Unsupported AI client" }, 400);
    }

    const mcps = await listMcpEnvironments(c.env.DB, company.id);
    const created = await createServiceIdentity(c.env.DB, {
      companyId: company.id,
      name: `${company.name} ${clientType === "chatgpt" ? "ChatGPT" : "Claude"}`,
      identityType: clientType,
      scopes: ["knowledge.search", "knowledge.read", "system.health"],
      mcpEnvironmentId: mcps[0]?.id ?? null,
    });

    await c.env.DB.prepare(
      `UPDATE ai_client_connections
       SET status = 'connected', service_identity_id = ?, updated_at = ?
       WHERE company_id = ? AND client_type = ?`,
    )
      .bind(created.identity.id, nowIso(), company.id, clientType)
      .run();

    return c.json({
      clientType,
      status: "connected",
      identity: created.identity,
      token: created.token,
      gatewayEndpoint:
        "https://infra-api.daniel-dwyer123.workers.dev/api/gateway/v1/execute",
      mcpEndpoint:
        "https://infra-api.daniel-dwyer123.workers.dev/api/gateway/v1/mcp",
      setup: {
        preferred: "Connect ChatGPT/Claude MCP to mcpEndpoint with Bearer token",
        auth: "Authorization: Bearer <token>",
        mcpUrl:
          "https://infra-api.daniel-dwyer123.workers.dev/api/gateway/v1/mcp",
        restBody: {
          companyId: company.id,
          toolName: "search_company_knowledge",
          arguments: { query: "..." },
          clientRequestId: "unique-per-logical-request",
        },
        critical:
          "Do NOT point ChatGPT at the company MCP URL directly — that bypasses INFRA metering and permissions.",
      },
      warning: "Store this token securely. It will not be shown again.",
    });
  },
);

// ---------- Connector instances (framework: configure without secrets in response) ----------

phase3.post(
  "/api/companies/:slug/connectors/:definitionId/instances",
  requireAuth,
  async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }

    const body = await c.req.json<{
      name?: string;
      config?: Record<string, unknown>;
      secretRef?: string;
      secretLabel?: string;
    }>();

    const definitionId = c.req.param("definitionId");
    const id = newId("ci");
    const now = nowIso();
    const name = body.name ?? `${company.name} connector`;

    // Never accept plaintext secrets into config_json
    const safeConfig = { ...(body.config ?? {}) };
    delete (safeConfig as Record<string, unknown>).apiKey;
    delete (safeConfig as Record<string, unknown>).password;
    delete (safeConfig as Record<string, unknown>).token;
    delete (safeConfig as Record<string, unknown>).clientSecret;

    await c.env.DB.prepare(
      `INSERT INTO connector_instances (
        id, company_id, connector_definition_id, name, status, config_json,
        sync_settings_json, data_environment_id, last_sync_at, last_sync_status,
        last_sync_message, health_status, health_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'draft', ?, ?, NULL, NULL, NULL, NULL, 'unknown', 'Awaiting credentials', ?, ?)`,
    )
      .bind(
        id,
        company.id,
        definitionId,
        name,
        JSON.stringify(safeConfig),
        JSON.stringify({ enabled: false, mode: "manual", schedule: null }),
        now,
        now,
      )
      .run();

    if (body.secretRef) {
      await c.env.DB.prepare(
        `INSERT INTO credential_refs (
          id, company_id, connector_instance_id, label, provider, secret_ref,
          status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      )
        .bind(
          newId("cred"),
          company.id,
          id,
          body.secretLabel ?? "Primary credential",
          definitionId,
          body.secretRef,
          now,
          now,
        )
        .run();
    }

    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "connector.instance_created",
      actor: c.get("user").email,
      resourceType: "connector",
      resourceId: id,
      detail: { definitionId, hasSecretRef: Boolean(body.secretRef) },
    });

    const row = await c.env.DB.prepare(
      `SELECT * FROM connector_instances WHERE id = ?`,
    )
      .bind(id)
      .first();

    return c.json({
      id,
      companyId: company.id,
      connectorDefinitionId: definitionId,
      name,
      status: "draft",
      config: safeConfig,
      // Never return secret values
      credentialConfigured: Boolean(body.secretRef),
      createdAt: now,
    });
  },
);

phase3.get("/api/companies/:slug/credentials", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  const rows = await c.env.DB.prepare(
    `SELECT id, company_id, connector_instance_id, label, provider, status, expires_at, created_at, updated_at
     FROM credential_refs WHERE company_id = ?`,
  )
    .bind(company.id)
    .all();

  // Intentionally omit secret_ref from list responses for company users;
  // platform admin may see ref name only (not value).
  return c.json(
    (rows.results ?? []).map((row) => ({
      id: String(row.id),
      companyId: String(row.company_id),
      connectorInstanceId: row.connector_instance_id
        ? String(row.connector_instance_id)
        : null,
      label: String(row.label),
      provider: String(row.provider),
      status: String(row.status),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      hasSecretRef: true,
    })),
  );
});

// ---------- Commercial / pricing admin ----------

phase3.get("/api/commercial/summary", requireAuth, requirePlatformAdmin, async (c) => {
  await ensureDefaultPricing(c.env.DB);
  await ensureProviderCostCatalogue(c.env.DB);
  const [usage, policies, rules, cards, exceptions] = await Promise.all([
    getUsageCommercialSummary(c.env.DB),
    listPricingPolicies(c.env.DB),
    listPricingRules(c.env.DB),
    listProviderRateCards(c.env.DB),
    listFinancialExceptions(c.env.DB, "open"),
  ]);
  return c.json({
    usage,
    policies,
    rules,
    providerRateCards: cards,
    openIntegrityExceptions: exceptions.length,
  });
});

phase3.get("/api/commercial/usage", requireAuth, requirePlatformAdmin, async (c) => {
  const companyId = c.req.query("companyId") || undefined;
  const sourceClient = c.req.query("sourceClient") || undefined;
  const successParam = c.req.query("success");
  const success =
    successParam === "1" || successParam === "true"
      ? true
      : successParam === "0" || successParam === "false"
        ? false
        : undefined;
  const [records, summary] = await Promise.all([
    listPlatformUsage(c.env.DB, 100, { companyId, sourceClient, success }),
    getUsageCommercialSummary(c.env.DB, companyId),
  ]);
  return c.json({ summary, records });
});

phase3.get("/api/commercial/provider-costs", requireAuth, requirePlatformAdmin, async (c) => {
  await ensureProviderCostCatalogue(c.env.DB);
  const cards = await listProviderRateCards(c.env.DB);
  const detailed = [];
  for (const card of cards) {
    const full = await getProviderRateCard(c.env.DB, card.id);
    if (full) detailed.push(full);
  }
  return c.json({
    cards: detailed,
    nextReviewNote:
      "Schedule approximately monthly. Proposed updates require Platform Admin approval — never auto-apply scraped tariffs.",
  });
});

phase3.get(
  "/api/commercial/provider-costs/:id",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    const full = await getProviderRateCard(c.env.DB, c.req.param("id"));
    if (!full) return c.json({ error: "Rate card not found" }, 404);
    return c.json(full);
  },
);

phase3.get("/api/commercial/pricing-rules", requireAuth, requirePlatformAdmin, async (c) => {
  await ensureDefaultPricing(c.env.DB);
  return c.json({
    policies: await listPricingPolicies(c.env.DB),
    rules: await listPricingRules(c.env.DB),
  });
});

phase3.post(
  "/api/commercial/provider-costs/:provider/request-review",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    const body = await c.req.json<{ sourceUrl?: string; notes?: string }>().catch(() => ({}));
    const id = await createManualPricingReviewProposal(c.env.DB, {
      provider: c.req.param("provider"),
      sourceUrl: body.sourceUrl,
      notes: body.notes,
      actor: c.get("user").email,
    });
    await recordAuditEvent(c.env.DB, {
      companyId: null,
      eventType: "company.accessed",
      actor: c.get("user").email,
      resourceType: "pricing",
      resourceId: id,
      detail: {
        stage: "pricing.rate_update_detected",
        provider: c.req.param("provider"),
        status: "pending_admin_review",
      },
    });
    return c.json({ reviewId: id, status: "pending" });
  },
);

phase3.get("/api/commercial/pricing-reviews", requireAuth, requirePlatformAdmin, async (c) => {
  return c.json({ reviews: await listPricingReviews(c.env.DB) });
});

phase3.post(
  "/api/commercial/reconciliation/run",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    const result = await runFinancialReconciliation(c.env.DB);
    await recordAuditEvent(c.env.DB, {
      companyId: null,
      eventType: "company.accessed",
      actor: c.get("user").email,
      resourceType: "billing",
      resourceId: "reconciliation",
      detail: result,
    });
    return c.json(result);
  },
);

phase3.get(
  "/api/commercial/reconciliation/exceptions",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    const status = c.req.query("status") ?? "open";
    return c.json({ exceptions: await listFinancialExceptions(c.env.DB, status) });
  },
);

export default phase3;
