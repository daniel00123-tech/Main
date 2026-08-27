import { Hono } from "hono";
import {
  CONNECTOR_CATALOGUE,
  CONNECTOR_ERROR_CODES,
  customerConnectorError,
  getConnectorById,
  publicConnectorDefinition,
} from "@infra/shared";
import type { Env } from "../env";
import {
  loadSession,
  requireAuth,
  requirePlatformAdmin,
  type AuthVariables,
} from "../auth/middleware";
import {
  getCompanyBySlug,
  getConnectorInstance,
  getMcpEnvironment,
  listConnectorOversight,
  recordAuditEvent,
  refreshMcpCapabilities,
} from "../services/control-plane";
import {
  getUserCompanyRole,
  userHasCompanyAccess,
} from "../permissions/service";
import { buildCompanyReadiness } from "../services/onboarding";
import { getWalletBalance, listLedgerEntries } from "../services/ledger";
import { listMcpEnvironments, listConnectorInstances } from "../services/control-plane";
import {
  consumeOauthAuthorizationState,
  oauthProviderNotActivated,
} from "../services/connector-oauth";
import {
  disconnectXero,
  handleXeroOAuthCallback,
  publicXeroView,
  selectXeroOrganisation,
  startXeroOAuth,
  startXeroScopeUpgrade,
  testXeroConnection,
  xeroOauthStatus,
} from "../services/xero";
import {
  connectorHasProviderTest,
  getConnectorCredentialMetadata,
  partitionConnectorInput,
  rejectPlaintextCredentialStore,
  revokeConnectorCredential,
  rotateConnectorCredential,
  sanitizeConnectorConfig,
  storeConnectorCredential,
} from "../services/connector-credentials";
import { credentialStorageStatus } from "../services/secrets";
import { deriveConnectorPresentation } from "../services/connector-lifecycle";
import { newId, nowIso } from "../db/mappers";
import { assertCompanyAcceptsGateway } from "../services/tenant-provisioning";

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const connectors = new Hono<AppEnv>();

function canManageCompany(user: AuthVariables["user"], companyId: string) {
  if (user.isPlatformAdmin) return true;
  const role = getUserCompanyRole(user, companyId);
  return role === "company_admin" || role === "director";
}

connectors.get("/api/connectors/catalogue", requireAuth, (c) =>
  c.json(CONNECTOR_CATALOGUE.map(publicConnectorDefinition)),
);

connectors.get("/api/credential-storage", requireAuth, async (c) => {
  const { microsoftOAuthStatus } = await import("../services/microsoft-oauth");
  return c.json({
    ...credentialStorageStatus(c.env),
    xero: xeroOauthStatus(c.env),
    microsoft: microsoftOAuthStatus(c.env),
  });
});

connectors.get("/api/admin/connectors", requireAuth, requirePlatformAdmin, async (c) => {
  const rows = await listConnectorOversight(c.env.DB);
  return c.json(
    rows.map((row) => {
      const presentation = deriveConnectorPresentation(row);
      return {
        companyId: row.companyId,
        companyName: row.companyName,
        companySlug: row.companySlug,
        companyStatus: row.companyStatus,
        connectorInstanceId: row.id,
        connectorDefinitionId: row.connectorDefinitionId,
        name: row.name,
        status: row.status,
        authStatus: presentation.authStatus,
        syncHealth: presentation.syncHealth,
        providerHealth: presentation.providerHealth,
        lastSyncAt: row.lastSyncAt,
        lastSuccessfulSyncAt: row.lastSuccessfulSyncAt ?? null,
        lastErrorCode: row.lastErrorCode ?? null,
        lastErrorMessage: row.lastErrorMessage ?? null,
        managedBy: row.managedBy ?? null,
      };
    }),
  );
});

connectors.post(
  "/api/mcp-environments/:id/refresh-capabilities",
  requireAuth,
  async (c) => {
    const environment = await getMcpEnvironment(c.env.DB, c.req.param("id"));
    if (!environment) return c.json({ error: "MCP environment not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), environment.companyId)) {
      return c.json({ error: "Access to this company is denied" }, 403);
    }
    const result = await refreshMcpCapabilities(
      c.env,
      environment.id,
      c.get("user").email,
    );
    if (!result) return c.json({ error: "MCP environment not found" }, 404);
    return c.json({ ...result, billed: false });
  },
);

connectors.get("/api/companies/:slug/readiness", requireAuth, async (c) => {
  const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }
  const [mcpEnvironments, connectorInstances, wallet, ledger, adminRow, identityRow, usageRow] =
    await Promise.all([
      listMcpEnvironments(c.env.DB, company.id),
      listConnectorInstances(c.env.DB, company.id),
      getWalletBalance(c.env.DB, company.id),
      listLedgerEntries(c.env.DB, company.id, 50),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS count FROM company_memberships
         WHERE company_id = ? AND role = 'company_admin' AND status = 'active'`,
      )
        .bind(company.id)
        .first(),
      c.env.DB.prepare(
        `SELECT SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count
         FROM service_identities WHERE company_id = ?`,
      )
        .bind(company.id)
        .first(),
      c.env.DB.prepare(`SELECT COUNT(*) AS count FROM usage_records WHERE company_id = ?`)
        .bind(company.id)
        .first(),
    ]);
  return c.json(
    buildCompanyReadiness({
      company,
      mcp: mcpEnvironments[0] ?? null,
      connectors: connectorInstances,
      wallet,
      ledger,
      adminCount: Number(adminRow?.count ?? 0),
      activeTokenCount: Number(identityRow?.active_count ?? 0),
      usageCount: Number(usageRow?.count ?? 0),
    }),
  );
});

connectors.post(
  "/api/companies/:slug/connectors/:definitionId/setup",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    if (company.status === "suspended") {
      return c.json(customerConnectorError(CONNECTOR_ERROR_CODES.SUSPENDED), 403);
    }

    const definition = getConnectorById(c.req.param("definitionId"));
    if (!definition) return c.json({ error: "Unknown connector" }, 404);

    const body = await c.req.json<{
      name?: string;
      config?: Record<string, unknown>;
      credentials?: Record<string, unknown>;
    }>().catch(() => ({
      name: undefined,
      config: undefined,
      credentials: undefined,
    }));

    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "connector.setup_started",
      actor: c.get("user").email,
      resourceType: "connector",
      resourceId: definition.id,
      detail: { definitionId: definition.id },
    });

    const storage = credentialStorageStatus(c.env);
    if (body.credentials && Object.keys(body.credentials).length > 0 && !storage.enabled) {
      return c.json(rejectPlaintextCredentialStore().body, 409);
    }

    const id = newId("ci");
    const now = nowIso();
    const partitioned = partitionConnectorInput(definition, body.credentials, body.config);
    const safeConfig = sanitizeConnectorConfig(partitioned.publicConfig);
    await c.env.DB.prepare(
      `INSERT INTO connector_instances (
        id, company_id, connector_definition_id, name, status, config_json,
        sync_settings_json, data_environment_id, last_sync_at, last_sync_status,
        last_sync_message, health_status, health_message, auth_status, sync_health,
        provider_health, managed_by, configured_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'draft', ?, ?, NULL, NULL, NULL, NULL, 'unknown',
        'Awaiting credentials', 'credentials_required', 'not_applicable', 'unknown',
        'infra', ?, ?, ?)`,
    )
      .bind(
        id,
        company.id,
        definition.id,
        body.name ?? `${company.name} · ${definition.name}`,
        JSON.stringify(safeConfig),
        JSON.stringify({ enabled: false, mode: "manual", schedule: null }),
        c.get("user").email,
        now,
        now,
      )
      .run();

    let credentialRefId: string | null = null;
    if (storage.enabled && Object.keys(partitioned.secretPayload).length > 0) {
      const stored = await storeConnectorCredential({
        env: c.env,
        companyId: company.id,
        instanceId: id,
        label: "Primary credential",
        provider: definition.id,
        credentials: partitioned.secretPayload,
        actor: c.get("user").email,
      });
      if (!stored.ok) return c.json(stored.body, stored.status);
      credentialRefId = stored.credentialRefId;
    }

    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "connector.instance_created",
      actor: c.get("user").email,
      resourceType: "connector",
      resourceId: id,
      detail: {
        definitionId: definition.id,
        credentialStored: Boolean(credentialRefId),
      },
    });

    return c.json({
      id,
      companyId: company.id,
      connectorDefinitionId: definition.id,
      status: credentialRefId ? "configured" : "draft",
      authStatus: credentialRefId ? "configuring" : "credentials_required",
      credentialSubmission: storage.enabled ? "enabled" : "disabled",
      credentialRefId,
    });
  },
);

connectors.post(
  "/api/companies/:slug/connectors/:instanceId/credentials",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    if (company.status === "suspended") {
      return c.json(customerConnectorError(CONNECTOR_ERROR_CODES.SUSPENDED), 403);
    }
    const instance = await getConnectorInstance(c.env.DB, c.req.param("instanceId"));
    if (!instance || instance.companyId !== company.id) {
      return c.json({ error: "Connector not found" }, 404);
    }
    const body = await c.req.json<{
      secretValue?: string;
      credentials?: Record<string, unknown>;
      config?: Record<string, unknown>;
      label?: string;
    }>().catch(() => ({
      secretValue: undefined,
      credentials: undefined,
      config: undefined,
      label: undefined,
    }));
    const stored = await storeConnectorCredential({
      env: c.env,
      companyId: company.id,
      instanceId: instance.id,
      label: body.label ?? "Primary credential",
      provider: instance.connectorDefinitionId,
      secretValue: body.secretValue,
      credentials: body.credentials,
      config: body.config,
      actor: c.get("user").email,
    });
    if (!stored.ok) return c.json(stored.body, stored.status);
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "connector.connected",
      actor: c.get("user").email,
      resourceType: "connector",
      resourceId: instance.id,
      detail: { credentialRefId: stored.credentialRefId, providerTested: false },
    });
    return c.json({
      ok: true,
      credentialRefId: stored.credentialRefId,
      stored: true,
      tested: false,
      authStatus: "configuring",
    });
  },
);

connectors.get(
  "/api/companies/:slug/connectors/:instanceId/credentials",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access to this company is denied" }, 403);
    }
    const instance = await getConnectorInstance(c.env.DB, c.req.param("instanceId"));
    if (!instance || instance.companyId !== company.id) {
      return c.json({ error: "Connector not found" }, 404);
    }
    const metadata = await getConnectorCredentialMetadata({
      env: c.env,
      companyId: company.id,
      instanceId: instance.id,
    });
    return c.json({
      ...metadata,
      storage: credentialStorageStatus(c.env),
      xero:
        instance.connectorDefinitionId === "conn_xero"
          ? publicXeroView(instance)
          : undefined,
    });
  },
);

connectors.post(
  "/api/companies/:slug/connectors/:instanceId/rotate",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    if (company.status === "suspended") {
      return c.json(customerConnectorError(CONNECTOR_ERROR_CODES.SUSPENDED), 403);
    }
    const instance = await getConnectorInstance(c.env.DB, c.req.param("instanceId"));
    if (!instance || instance.companyId !== company.id) {
      return c.json({ error: "Connector not found" }, 404);
    }
    const body = await c.req.json<{
      secretValue?: string;
      credentials?: Record<string, unknown>;
      config?: Record<string, unknown>;
      credentialRefId?: string;
    }>().catch(() => ({
      secretValue: undefined,
      credentials: undefined,
      config: undefined,
      credentialRefId: undefined,
    }));
    const credentialRefId = body.credentialRefId ?? instance.credentialRefId;
    if (!credentialRefId) {
      return c.json(customerConnectorError(CONNECTOR_ERROR_CODES.CONFIG_INCOMPLETE), 409);
    }
    const rotated = await rotateConnectorCredential({
      env: c.env,
      companyId: company.id,
      instanceId: instance.id,
      credentialRefId,
      secretValue: body.secretValue,
      credentials: body.credentials,
      config: body.config,
      actor: c.get("user").email,
    });
    if (!rotated.ok) return c.json(rotated.body, rotated.status);
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "connector.credentials_rotated",
      actor: c.get("user").email,
      resourceType: "connector",
      resourceId: instance.id,
      detail: { credentialRefId },
    });
    return c.json({ ok: true });
  },
);

connectors.post(
  "/api/companies/:slug/connectors/:instanceId/test",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    if (company.status === "suspended" || company.status === "archived") {
      return c.json(
        customerConnectorError(
          company.status === "suspended"
            ? CONNECTOR_ERROR_CODES.SUSPENDED
            : CONNECTOR_ERROR_CODES.COMPANY_INACTIVE,
        ),
        403,
      );
    }
    const instance = await getConnectorInstance(c.env.DB, c.req.param("instanceId"));
    if (!instance || instance.companyId !== company.id) {
      return c.json({ error: "Connector not found" }, 404);
    }
    if (instance.connectorDefinitionId === "conn_xero") {
      const result = await testXeroConnection({
        env: c.env,
        companyId: company.id,
        instanceId: instance.id,
        actor: c.get("user").email,
      });
      return c.json(result, result.tested ? 200 : 409);
    }
    const tested = connectorHasProviderTest(instance.connectorDefinitionId);
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: tested
        ? "credential.validation_succeeded"
        : "credential.validation_failed",
      actor: c.get("user").email,
      resourceType: "connector",
      resourceId: instance.id,
      detail: { tested: false, reason: "no_provider_test" },
    });
    return c.json({
      tested: false,
      code: "NO_PROVIDER_TEST",
      message:
        "No provider test is available for this connector yet. Credentials were not re-checked against the provider.",
    });
  },
);

connectors.post(
  "/api/companies/:slug/connectors/:instanceId/disconnect",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    const instance = await getConnectorInstance(c.env.DB, c.req.param("instanceId"));
    if (!instance || instance.companyId !== company.id) {
      return c.json({ error: "Connector not found" }, 404);
    }
    if (instance.connectorDefinitionId === "conn_xero") {
      const revoked = await disconnectXero({
        env: c.env,
        companyId: company.id,
        instanceId: instance.id,
        actor: c.get("user").email,
      });
      if (!revoked.ok) return c.json(revoked.body, revoked.status);
      return c.json({ ok: true, authStatus: "revoked" });
    }
    const revoked = await revokeConnectorCredential({
      env: c.env,
      companyId: company.id,
      instanceId: instance.id,
      actor: c.get("user").email,
    });
    if (!revoked.ok) return c.json(revoked.body, revoked.status);
    return c.json({ ok: true, authStatus: "revoked" });
  },
);

connectors.post(
  "/api/companies/:slug/connectors/:definitionId/oauth/start",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    if (company.status === "suspended") {
      return c.json(customerConnectorError(CONNECTOR_ERROR_CODES.SUSPENDED), 403);
    }
    const definition = getConnectorById(c.req.param("definitionId"));
    if (!definition) return c.json({ error: "Unknown connector" }, 404);

    if (definition.id === "conn_xero") {
      const started = await startXeroOAuth({
        env: c.env,
        companyId: company.id,
        companySlug: company.slug,
        userId: c.get("user").userId,
        actor: c.get("user").email,
      });
      if (!started.ok) return c.json(started.body, started.status);
      return c.json({
        authorizationUrl: started.authorizationUrl,
        expiresAt: started.expiresAt,
        instanceId: started.instanceId,
        pkce: "S256",
      });
    }

    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "connector.setup_started",
      actor: c.get("user").email,
      resourceType: "connector",
      resourceId: definition.id,
      detail: { flow: "oauth", activated: false },
    });
    return c.json(
      {
        ...oauthProviderNotActivated(),
        stateIssued: false,
        pkce: "S256",
      },
      409,
    );
  },
);

connectors.get("/api/connectors/xero/oauth/callback", loadSession, async (c) => {
  const user = c.get("user");
  const result = await handleXeroOAuthCallback({
    env: c.env,
    state: c.req.query("state") ?? "",
    code: c.req.query("code") ?? null,
    error: c.req.query("error") ?? null,
    sessionUserId: user?.userId ?? null,
  });
  return c.redirect(result.redirectTo, 302);
});

connectors.post(
  "/api/companies/:slug/connectors/:instanceId/xero/select-organisation",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    const instance = await getConnectorInstance(c.env.DB, c.req.param("instanceId"));
    if (!instance || instance.companyId !== company.id) {
      return c.json({ error: "Connector not found" }, 404);
    }
    const body = await c.req.json<{ tenantId?: string }>().catch(() => ({ tenantId: "" }));
    const selected = await selectXeroOrganisation({
      env: c.env,
      companyId: company.id,
      instanceId: instance.id,
      tenantId: body.tenantId ?? "",
      actor: c.get("user").email,
    });
    if (!selected.ok) return c.json(selected.body, selected.status);
    return c.json({ ok: true, organisationName: selected.organisationName });
  },
);

connectors.post(
  "/api/companies/:slug/connectors/:instanceId/xero/scope-upgrade",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    if (company.status === "suspended") {
      return c.json(customerConnectorError(CONNECTOR_ERROR_CODES.SUSPENDED), 403);
    }
    const instance = await getConnectorInstance(c.env.DB, c.req.param("instanceId"));
    if (!instance || instance.companyId !== company.id) {
      return c.json({ error: "Connector not found" }, 404);
    }
    if (instance.connectorDefinitionId !== "conn_xero") {
      return c.json({ error: "Not a Xero connector" }, 400);
    }
    const started = await startXeroScopeUpgrade({
      env: c.env,
      companyId: company.id,
      companySlug: company.slug,
      userId: c.get("user").userId,
      actor: c.get("user").email,
      instanceId: instance.id,
    });
    if (!started.ok) return c.json(started.body, started.status);
    return c.json({
      authorizationUrl: started.authorizationUrl,
      expiresAt: started.expiresAt,
      instanceId: started.instanceId,
      requestedScopes: started.requestedScopes,
      pkce: "S256",
    });
  },
);

connectors.get("/api/connectors/oauth/callback", requireAuth, async (c) => {
  const state = c.req.query("state") ?? "";
  const consumed = await consumeOauthAuthorizationState(c.env.DB, {
    state,
    userId: c.get("user").userId,
  });
  if (!consumed.ok) return c.json(consumed.error, 400);
  if (!userHasCompanyAccess(c.get("user"), consumed.value.companyId)) {
    return c.json(customerConnectorError(CONNECTOR_ERROR_CODES.OAUTH_STATE_INVALID), 403);
  }
  await recordAuditEvent(c.env.DB, {
    companyId: consumed.value.companyId,
    eventType: "connector.connection_failed",
    actor: c.get("user").email,
    resourceType: "connector",
    resourceId: consumed.value.definitionId,
    detail: { reason: "oauth_not_activated", tokenPersisted: false },
  });
  return c.json({ ...oauthProviderNotActivated(), tokenPersisted: false }, 409);
});

connectors.post(
  "/api/companies/:slug/connectors/:instanceId/health",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access to this company is denied" }, 403);
    }
    const instance = await getConnectorInstance(c.env.DB, c.req.param("instanceId"));
    if (!instance || instance.companyId !== company.id) {
      return c.json({ error: "Connector not found" }, 404);
    }
    const presentation = deriveConnectorPresentation(instance);
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "connector.health_checked",
      actor: c.get("user").email,
      resourceType: "connector",
      resourceId: instance.id,
      detail: { billed: false, ...presentation },
    });
    return c.json({
      ...presentation,
      lastSyncAt: instance.lastSyncAt,
      lastSuccessfulSyncAt: instance.lastSuccessfulSyncAt ?? null,
      billed: false,
    });
  },
);

connectors.post(
  "/api/companies/:slug/connectors/:instanceId/execute",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access to this company is denied" }, 403);
    }
    const lifecycle = await assertCompanyAcceptsGateway(c.env.DB, company.id);
    if (!lifecycle.ok) {
      return c.json({ error: lifecycle.error }, 403);
    }
    return c.json(
      {
        error:
          "Manual connector execution goes through the INFRA gateway and is not enabled for this connector yet",
        code: "CONNECTOR_EXECUTION_NOT_ENABLED",
      },
      409,
    );
  },
);

connectors.get("/api/connectors/microsoft/status", requireAuth, async (c) => {
  const { microsoftOAuthStatus } = await import("../services/microsoft-oauth");
  return c.json(microsoftOAuthStatus(c.env));
});

connectors.get("/api/connectors/microsoft/health", requireAuth, async (c) => {
  const { getMicrosoftConnectorHealth } = await import("../services/microsoft-sync");
  return c.json(await getMicrosoftConnectorHealth(c.env));
});

connectors.get(
  "/api/companies/:slug/microsoft/dashboard",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    const instanceId = c.req.query("instanceId") ?? null;
    const { listMicrosoftSources } = await import("../services/microsoft-sync");
    const { getMicrosoftConnectorHealth } = await import("../services/microsoft-sync");
    const { microsoftOAuthStatus } = await import("../services/microsoft-oauth");
    const sources = await listMicrosoftSources(c.env.DB, company.id, instanceId);
    const health = await getMicrosoftConnectorHealth(c.env);
    const onedrive = sources.filter((s) => s.sourceType === "onedrive");
    const sharepoint = sources.filter((s) => s.sourceType === "sharepoint");
    const outlook = sources.filter((s) => s.sourceType === "outlook_shared");
    return c.json({
      status: microsoftOAuthStatus(c.env),
      health,
      summary: {
        onedrive: {
          total: onedrive.length,
          included: onedrive.filter((s) => s.inclusionStatus === "included").length,
          indexed: onedrive.reduce((n, s) => n + s.itemsIndexed, 0),
        },
        sharepoint: {
          total: sharepoint.length,
          included: sharepoint.filter((s) => s.inclusionStatus === "included").length,
          indexed: sharepoint.reduce((n, s) => n + s.itemsIndexed, 0),
        },
        outlook: { total: outlook.length, status: "requires_additional_permission" },
      },
      sources,
    });
  },
);

connectors.post(
  "/api/companies/:slug/microsoft/discover",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      instanceId?: string;
      includeAllOneDrives?: boolean;
      includeAllSharePoint?: boolean;
    };
    const instances = await listConnectorInstances(c.env.DB, company.id);
    let instance = instances.find((i) => i.id === body.instanceId);
    if (!instance) {
      instance = instances.find((i) => i.connectorDefinitionId === "conn_microsoft_365");
    }
    if (!instance) {
      const { newId: genId, nowIso: now } = await import("../db/mappers");
      const instanceId = genId("ci");
      await c.env.DB.prepare(
        `INSERT INTO connector_instances (id, company_id, connector_definition_id, name, status, auth_status, created_at, updated_at)
         VALUES (?, ?, 'conn_microsoft_365', 'Microsoft 365', 'configured', 'connected', ?, ?)`,
      ).bind(instanceId, company.id, now(), now()).run();
      instance = (await getConnectorInstance(c.env.DB, instanceId))!;
    }
    const { discoverMicrosoftSources } = await import("../services/microsoft-sync");
    const result = await discoverMicrosoftSources(c.env, {
      companyId: company.id,
      connectorInstanceId: instance.id,
      actor: c.get("user").email,
      includeAllOneDrives: body.includeAllOneDrives ?? false,
      includeAllSharePoint: body.includeAllSharePoint ?? false,
    });
    return c.json({ ok: true, instanceId: instance.id, ...result });
  },
);

connectors.post(
  "/api/companies/:slug/microsoft/sources/:sourceId/sync",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      instanceId?: string;
      useDelta?: boolean;
      maxFiles?: number;
    };
    const source = await c.env.DB.prepare(
      `SELECT connector_instance_id FROM microsoft_connector_sources WHERE id = ? AND company_id = ? LIMIT 1`,
    ).bind(c.req.param("sourceId"), company.id).first<{ connector_instance_id: string }>();
    if (!source) return c.json({ error: "Source not found" }, 404);

    const { syncMicrosoftSource } = await import("../services/microsoft-sync");
    const result = await syncMicrosoftSource(c.env, {
      companyId: company.id,
      connectorInstanceId: source.connector_instance_id,
      sourceId: c.req.param("sourceId"),
      actor: c.get("user").email,
      useDelta: body.useDelta ?? false,
      maxFiles: body.maxFiles,
    });
    return c.json({ ok: true, ...result });
  },
);

connectors.patch(
  "/api/companies/:slug/microsoft/sources/:sourceId/inclusion",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    const body = await c.req.json<{ inclusionStatus: "included" | "excluded" | "available" }>();
    const { setMicrosoftSourceInclusion } = await import("../services/microsoft-sync");
    await setMicrosoftSourceInclusion(c.env.DB, {
      companyId: company.id,
      sourceId: c.req.param("sourceId"),
      inclusionStatus: body.inclusionStatus,
      actor: c.get("user").email,
    });
    return c.json({ ok: true });
  },
);

connectors.post(
  "/api/companies/:slug/connectors/microsoft/oauth/start",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      definitionId?: string;
      instanceId?: string;
      component?: string;
    };
    const { startMicrosoftOAuth } = await import("../services/microsoft-oauth");
    const result = await startMicrosoftOAuth(c.env.DB, c.env, {
      companyId: company.id,
      userId: c.get("user").userId,
      definitionId: body.definitionId ?? "conn_microsoft_365",
      instanceId: body.instanceId ?? null,
      component: (body.component as "onedrive" | "sharepoint" | "outlook_shared" | "microsoft_365") ?? "microsoft_365",
      returnPath: `/portal/${company.slug}/connectors`,
    });
    if (!result.ok) return c.json({ error: result.message, code: result.code }, 409);
    return c.json({ authorizationUrl: result.authorizationUrl, state: result.state });
  },
);

connectors.get(
  "/api/companies/:slug/xero/test-artefacts",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    const user = c.get("user");
    if (!user.isPlatformAdmin && !canManageCompany(user, company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    const prefix = c.req.query("prefix") ?? "INFRA-";
    const instanceId = c.req.query("instanceId");
    const instances = await listConnectorInstances(c.env.DB, company.id);
    const xeroInstance =
      instances.find((i) => i.id === instanceId) ??
      instances.find((i) => i.connectorDefinitionId === "conn_xero" && i.authStatus === "connected");
    if (!xeroInstance) {
      return c.json({
        reportOnly: true,
        prefix,
        artefacts: [],
        note: "No connected Xero instance for this company.",
      });
    }
    const { searchXeroTestArtefacts } = await import("../services/action-engine/xero-test-artefacts");
    const manifest = await searchXeroTestArtefacts(c.env, {
      companyId: company.id,
      instanceId: xeroInstance.id,
      actor: user.email,
      prefix,
      limit: Number(c.req.query("limit") ?? 50),
    });
    return c.json({ ...manifest, instanceId: xeroInstance.id });
  },
);

connectors.get(
  "/api/companies/:slug/microsoft/sources",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    const instanceId = c.req.query("instanceId") ?? null;
    const { listMicrosoftConnectorSources } = await import("../services/microsoft-oauth");
    const sources = await listMicrosoftConnectorSources(
      c.env.DB,
      company.id,
      instanceId,
    );
    return c.json({ sources });
  },
);

export default connectors;
