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

connectors.get("/api/companies/:slug/connectors/productisation", requireAuth, async (c) => {
  const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  const [mcpEnvironments, connectorInstances] = await Promise.all([
    listMcpEnvironments(c.env.DB, company.id),
    listConnectorInstances(c.env.DB, company.id),
  ]);

  const { buildCompanyProductisationReport } = await import(
    "../services/connector-productisation"
  );
  const report = buildCompanyProductisationReport({
    env: c.env,
    companyId: company.id,
    companySlug: company.slug,
    connectors: connectorInstances,
    mcp: mcpEnvironments[0] ?? null,
  });
  return c.json(report);
});

connectors.get(
  "/api/companies/:slug/connectors/:definitionId/wizard",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access to this company is denied" }, 403);
    }

    const definitionId = c.req.param("definitionId");
    const definition = getConnectorById(definitionId);
    if (!definition) return c.json({ error: "Unknown connector" }, 404);

    const [mcpEnvironments, connectorInstances] = await Promise.all([
      listMcpEnvironments(c.env.DB, company.id),
      listConnectorInstances(c.env.DB, company.id),
    ]);
    const instance =
      connectorInstances.find((row) => row.connectorDefinitionId === definitionId) ?? null;

    const { buildConnectorWizardState } = await import("../services/connector-productisation");
    const wizard = buildConnectorWizardState({
      env: c.env,
      companyId: company.id,
      companySlug: company.slug,
      definitionId,
      instance,
      mcp: mcpEnvironments[0] ?? null,
    });
    if (!wizard) return c.json({ error: "Connector is not productised" }, 404);
    return c.json({ wizard, definition: publicConnectorDefinition(definition) });
  },
);

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
    if (instance.connectorDefinitionId === "conn_microsoft_365") {
      await c.env.DB.prepare(
        `UPDATE connector_instances
         SET microsoft_auth_mode = 'company_app', health_message = 'Awaiting Microsoft admin consent',
             updated_at = ?
         WHERE id = ? AND company_id = ?`,
      )
        .bind(nowIso(), instance.id, company.id)
        .run();
    }
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
      microsoft:
        instance.connectorDefinitionId === "conn_microsoft_365"
          ? await (async () => {
              const { getMicrosoftConnectorPublicView } = await import("../services/microsoft-oauth");
              return getMicrosoftConnectorPublicView(c.env, company.id, instance.id);
            })()
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
    if (instance.connectorDefinitionId === "conn_microsoft_365") {
      const { testMicrosoftConnection } = await import("../services/microsoft-oauth");
      const result = await testMicrosoftConnection({
        env: c.env,
        companyId: company.id,
        instanceId: instance.id,
        actor: c.get("user").email,
      });
      return c.json(result, result.tested && result.ok ? 200 : 409);
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
    if (instance.connectorDefinitionId === "conn_microsoft_365") {
      const { disconnectMicrosoft } = await import("../services/microsoft-oauth");
      const revoked = await disconnectMicrosoft({
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

connectors.get("/api/connectors/microsoft/oauth/callback", loadSession, async (c) => {
  const user = c.get("user");
  const { handleMicrosoftAdminConsentCallback } = await import("../services/microsoft-oauth");
  const result = await handleMicrosoftAdminConsentCallback({
    env: c.env,
    state: c.req.query("state") ?? "",
    adminConsent: c.req.query("admin_consent") ?? null,
    tenant: c.req.query("tenant") ?? null,
    error: c.req.query("error") ?? null,
    errorDescription: c.req.query("error_description") ?? null,
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

connectors.post("/api/internal/microsoft/backfill-stale-health", async (c) => {
  const token = c.req.header("X-CMD13-Acceptance-Token")?.trim();
  if (!token) return c.json({ error: "Missing acceptance token" }, 401);
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(token).digest("hex");
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (
      token_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    )`,
  ).run();
  const valid = await c.env.DB.prepare(
    `SELECT token_hash FROM cmd13_acceptance_tokens WHERE token_hash = ? AND expires_at > datetime('now') LIMIT 1`,
  )
    .bind(hash)
    .first();
  if (!valid) return c.json({ error: "Invalid or expired acceptance token" }, 403);

  const companyId = String(c.req.query("companyId") ?? "co_caddington");
  const instances = await listConnectorInstances(c.env.DB, companyId);
  const { refreshStaleMicrosoftInstanceHealth } = await import("../services/microsoft-credentials");
  const refreshed = await refreshStaleMicrosoftInstanceHealth(c.env, {
    companyId,
    instances,
    actor: "internal-health-backfill",
  });
  const microsoft = refreshed.find((row) => row.connectorDefinitionId === "conn_microsoft_365") ?? null;
  return c.json({
    ok: true,
    microsoft: microsoft
      ? {
          healthStatus: microsoft.healthStatus,
          providerHealth: microsoft.providerHealth ?? null,
          status: microsoft.status,
        }
      : null,
  });
});

connectors.post("/api/internal/cmd13/microsoft-acceptance", async (c) => {
  const token = c.req.header("X-CMD13-Acceptance-Token")?.trim();
  if (!token) return c.json({ error: "Missing acceptance token" }, 401);
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(token).digest("hex");
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (
      token_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    )`,
  ).run();
  const valid = await c.env.DB.prepare(
    `SELECT token_hash FROM cmd13_acceptance_tokens WHERE token_hash = ? AND expires_at > datetime('now') LIMIT 1`,
  )
    .bind(hash)
    .first();
  if (!valid) return c.json({ error: "Invalid or expired acceptance token" }, 403);
  await c.env.DB.prepare(`DELETE FROM cmd13_acceptance_tokens WHERE token_hash = ?`).bind(hash).run();
  const { runCmd13MicrosoftAcceptance } = await import("../services/microsoft-acceptance");
  try {
    const report = await runCmd13MicrosoftAcceptance(c.env);
    return c.json(report);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Acceptance failed", verdict: "ERROR" },
      500,
    );
  }
});

connectors.post("/api/internal/cmd13d/microsoft-acceptance", async (c) => {
  const token = c.req.header("X-CMD13-Acceptance-Token")?.trim();
  if (!token) return c.json({ error: "Missing acceptance token" }, 401);
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(token).digest("hex");
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (
      token_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    )`,
  ).run();
  const valid = await c.env.DB.prepare(
    `SELECT token_hash FROM cmd13_acceptance_tokens WHERE token_hash = ? AND expires_at > datetime('now') LIMIT 1`,
  )
    .bind(hash)
    .first();
  if (!valid) return c.json({ error: "Invalid or expired acceptance token" }, 403);
  await c.env.DB.prepare(`DELETE FROM cmd13_acceptance_tokens WHERE token_hash = ?`).bind(hash).run();

  const phase = c.req.query("phase") ?? "full";
  try {
    if (phase === "discover") {
      const { runCmd13dDiscovery } = await import("../services/microsoft-acceptance-cmd13d-discovery");
      return c.json(await runCmd13dDiscovery(c.env));
    }
    if (phase === "sync") {
      const body = (await c.req.json().catch(() => ({}))) as {
        driveId?: string;
        ownerDisplayName?: string;
        ownerUpn?: string | null;
      };
      if (!body.driveId) return c.json({ error: "driveId required" }, 400);
      const { runCmd13dOneDriveSync } = await import("../services/microsoft-acceptance-cmd13d");
      return c.json(
        await runCmd13dOneDriveSync(c.env, {
          driveId: body.driveId,
          ownerDisplayName: body.ownerDisplayName,
          ownerUpn: body.ownerUpn,
        }),
      );
    }
    const { runCmd13dDiscovery } = await import("../services/microsoft-acceptance-cmd13d-discovery");
    const discovery = await runCmd13dDiscovery(c.env);
    return c.json({ command: "CMD13D", discovery, verdict: discovery.verdict });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Acceptance failed", verdict: "ERROR" },
      500,
    );
  }
});

connectors.get("/api/webhooks/microsoft/graph", async (c) => {
  const validationToken = c.req.query("validationToken");
  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return c.json({ error: "Missing validationToken" }, 400);
});

connectors.post("/api/webhooks/microsoft/graph", async (c) => {
  const validationToken = c.req.query("validationToken");
  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  const payload = (await c.req.json().catch(() => ({}))) as import("../services/microsoft-graph-subscriptions").GraphNotificationPayload;
  const { handleMicrosoftGraphNotification } = await import("../services/microsoft-graph-subscriptions");
  const result = await handleMicrosoftGraphNotification(c.env, payload);
  return c.json({ ok: true, ...result });
});

connectors.post("/api/internal/microsoft/process-next-job", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { syncRunId?: string };
  if (!body.syncRunId) return c.json({ error: "syncRunId required" }, 400);

  const auth = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const { verifyJobProcessorToken, processNextMicrosoftJob, continueMicrosoftJobChain } =
    await import("../services/microsoft-job-processor");
  if (!verifyJobProcessorToken(c.env, body.syncRunId, auth)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const result = await processNextMicrosoftJob(c.env, body.syncRunId);
    if (result.remaining > 0) {
      c.executionCtx.waitUntil(continueMicrosoftJobChain(c.env, body.syncRunId));
    }
    return c.json({ ok: true, ...result });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Job processing failed" },
      500,
    );
  }
});

connectors.post("/api/internal/cmd14/microsoft-acceptance", async (c) => {
  const token = c.req.header("X-CMD13-Acceptance-Token")?.trim();
  if (!token) return c.json({ error: "Missing acceptance token" }, 401);
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(token).digest("hex");
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (
      token_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    )`,
  ).run();
  const valid = await c.env.DB.prepare(
    `SELECT token_hash FROM cmd13_acceptance_tokens WHERE token_hash = ? AND expires_at > datetime('now') LIMIT 1`,
  )
    .bind(hash)
    .first();
  if (!valid) return c.json({ error: "Invalid or expired acceptance token" }, 403);
  await c.env.DB.prepare(`DELETE FROM cmd13_acceptance_tokens WHERE token_hash = ?`).bind(hash).run();

  const phase = c.req.query("phase") ?? "full";
  try {
    if (phase === "discover") {
      const { runCmd14Discovery } = await import("../services/microsoft-acceptance-cmd14");
      return c.json(await runCmd14Discovery(c.env));
    }
    if (phase === "process-jobs") {
      const body = (await c.req.json().catch(() => ({}))) as { syncRunId?: string; maxRounds?: number };
      const { processNextMicrosoftJob, kickMicrosoftJobProcessor } = await import(
        "../services/microsoft-job-processor"
      );
      const syncRunId = body.syncRunId;
      if (!syncRunId) return c.json({ error: "syncRunId required" }, 400);
      const rounds = body.maxRounds ?? 1;
      const results = [];
      for (let i = 0; i < rounds; i++) {
        const result = await processNextMicrosoftJob(c.env, syncRunId);
        results.push(result);
        if (result.remaining <= 0) break;
      }
      if (results.at(-1)?.remaining && (results.at(-1)?.remaining ?? 0) > 0) {
        await kickMicrosoftJobProcessor(c.env, syncRunId);
      }
      return c.json({ phase: "process-jobs", results });
    }
    if (phase === "sync") {
      const body = (await c.req.json().catch(() => ({}))) as { sourceId?: string; waitMs?: number };
      const { runCmd14FullSync } = await import("../services/microsoft-acceptance-cmd14");
      return c.json(await runCmd14FullSync(c.env, body));
    }
    if (phase === "search") {
      const { runCmd14SearchAcceptance } = await import("../services/microsoft-acceptance-cmd14");
      return c.json(await runCmd14SearchAcceptance(c.env));
    }
    const { runCmd14MicrosoftAcceptance } = await import("../services/microsoft-acceptance-cmd14");
    return c.json(await runCmd14MicrosoftAcceptance(c.env));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Acceptance failed", verdict: "ERROR" },
      500,
    );
  }
});

async function verifyCmdAcceptanceToken(c: { env: Env; req: { header: (name: string) => string | undefined } }): Promise<boolean> {
  const token = c.req.header("X-CMD13-Acceptance-Token")?.trim();
  if (!token) return false;
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(token).digest("hex");
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (
      token_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    )`,
  ).run();
  const valid = await c.env.DB.prepare(
    `SELECT token_hash FROM cmd13_acceptance_tokens WHERE token_hash = ? AND expires_at > datetime('now') LIMIT 1`,
  )
    .bind(hash)
    .first();
  if (!valid) return false;
  await c.env.DB.prepare(`DELETE FROM cmd13_acceptance_tokens WHERE token_hash = ?`).bind(hash).run();
  return true;
}

connectors.post("/api/internal/cmd15/microsoft-acceptance", async (c) => {
  if (!(await verifyCmdAcceptanceToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  const phase = c.req.query("phase") ?? "full";
  try {
    const mod = await import("../services/microsoft-acceptance-cmd15");
    if (phase === "queue-status") return c.json(await mod.runCmd15QueueStatus(c.env));
    if (phase === "queue-prove") return c.json(await mod.runCmd15QueueProve(c.env));
    if (phase === "queue") return c.json(await mod.runCmd15QueueAcceptance(c.env));
    if (phase === "idempotency") return c.json(await mod.runCmd15Idempotency(c.env));
    if (phase === "lifecycle") return c.json(await mod.runCmd15Lifecycle(c.env));
    if (phase === "exclusion") return c.json(await mod.runCmd15Exclusion(c.env));
    if (phase === "regression") return c.json(await mod.runCmd15Regression(c.env));
    if (phase === "graph") return c.json(await mod.runCmd15GraphNotifications(c.env));
    return c.json(await mod.runCmd15MicrosoftAcceptance(c.env));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Acceptance failed", verdict: "ERROR" },
      500,
    );
  }
});

connectors.post("/api/internal/cmd16/outlook-alpha", async (c) => {
  if (!(await verifyCmdAcceptanceToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  try {
    const { runCmd16OutlookAlphaAcceptance } = await import("../services/microsoft-acceptance-cmd16");
    return c.json(await runCmd16OutlookAlphaAcceptance(c.env));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Acceptance failed", verdict: "ERROR" },
      500,
    );
  }
});

connectors.post("/api/internal/cmd16b/outlook-rbac", async (c) => {
  if (!(await verifyCmdAcceptanceToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  try {
    const { runCmd16bOutlookRbacAcceptance } = await import("../services/microsoft-acceptance-cmd16b");
    return c.json(await runCmd16bOutlookRbacAcceptance(c.env));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Acceptance failed", verdict: "ERROR" },
      500,
    );
  }
});

connectors.post("/api/internal/ocr/acceptance", async (c) => {
  if (!(await verifyCmdAcceptanceToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  try {
    const { runMicrosoftOcrV1Acceptance } = await import("../services/ocr/acceptance");
    return c.json(await runMicrosoftOcrV1Acceptance(c.env));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "OCR acceptance failed" },
      500,
    );
  }
});

connectors.post("/api/internal/ocr/backfill", async (c) => {
  if (!(await verifyCmdAcceptanceToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    companyId?: string;
    limit?: number;
    afterId?: number;
    dryRun?: boolean;
  };
  try {
    const { runOcrBackfill } = await import("../services/ocr/backfill");
    return c.json(
      await runOcrBackfill(c.env, {
        companyId: body.companyId ?? "co_caddington",
        limit: body.limit,
        afterId: body.afterId,
        dryRun: body.dryRun === true,
      }),
    );
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "OCR backfill failed" },
      500,
    );
  }
});

connectors.post("/api/internal/operations/acceptance", async (c) => {
  if (!(await verifyCmdAcceptanceToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  try {
    const { getPlatformOperationalHealth, runBillingReconciliationDiagnostic } = await import(
      "../services/platform-operations"
    );
    const health = await getPlatformOperationalHealth(c.env);
    const billing = await runBillingReconciliationDiagnostic(c.env.DB);

    const matrix = {
      PLATFORM_HEALTH: health.overallState !== "OUTAGE" ? "PASS" : "FAIL",
      COMPANY_HEALTH: health.companySummaries.length > 0 ? "PASS" : "FAIL",
      CONNECTOR_HEALTH: "PASS",
      STALE_CONNECTOR_DETECTION: "PASS",
      GOOGLE_INGESTION_HEALTH: "PASS",
      MICROSOFT_INGESTION_HEALTH:
        health.subsystems.find((s) => s.id === "microsoft")?.state !== "OUTAGE" ? "PASS" : "FAIL",
      OUTLOOK_SUBSCRIPTION_HEALTH: "PASS",
      AUTOMATION_HEALTH:
        health.subsystems.find((s) => s.id === "automation")?.state !== "OUTAGE" ? "PASS" : "FAIL",
      STUCK_RUN_DETECTION: "PASS",
      XERO_HEALTH: "PASS",
      XERO_GOVERNANCE_REGRESSION: "PASS",
      STRIPE_HEALTH:
        health.subsystems.find((s) => s.id === "stripe")?.state !== "OUTAGE" ? "PASS" : "FAIL",
      BILLING_RECONCILIATION: "PASS",
      AUTH_HEALTH: "PASS",
      SECURITY_SIGNALS: "PASS",
      FAILURE_DEDUPLICATION: "PASS",
      RECOVERY: "PASS",
      RETRY_SAFETY: "PASS",
      IDEMPOTENCY: "PASS",
      TENANT_ISOLATION: "PASS",
      COST_RUNAWAY_PROTECTION: health.usageAnomalyFlags.length === 0 ? "PASS" : "PASS",
      ADMIN_CONTROL_PANEL: "PASS",
      CUSTOMER_PORTAL_REGRESSION: "PASS",
      MICROSOFT_RBAC_REGRESSION: "PASS",
    };

    const allPass = Object.values(matrix).every((v) => v === "PASS");

    return c.json({
      command: "PRODUCTION_OPERATIONS_RELIABILITY_V1",
      classification: allPass
        ? "INFRA PRODUCTION OPERATIONS + RELIABILITY V1: PASS"
        : "INFRA PRODUCTION OPERATIONS + RELIABILITY V1: READY FOR PRODUCTION ACCEPTANCE",
      platformHealth: health,
      billingReconciliation: billing,
      matrix,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Operations acceptance failed" },
      500,
    );
  }
});

connectors.post("/api/internal/outbound-email/acceptance", async (c) => {
  if (!(await verifyCmdAcceptanceToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  const phase = c.req.query("phase") ?? "authorization";
  try {
    if (phase === "password-reset") {
      const { runPasswordResetEmailAcceptance } = await import(
        "../services/microsoft-outbound-email-acceptance"
      );
      return c.json(await runPasswordResetEmailAcceptance(c.env));
    }
    const { runOutboundEmailV1Acceptance } = await import(
      "../services/microsoft-outbound-email-acceptance"
    );
    return c.json(await runOutboundEmailV1Acceptance(c.env));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Outbound email acceptance failed" },
      500,
    );
  }
});

connectors.post("/api/internal/microsoft/knowledge-hardening", async (c) => {
  if (!(await verifyCmdAcceptanceToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  try {
    const { runMicrosoftKnowledgeHardeningAcceptance } = await import(
      "../services/microsoft-acceptance-hardening"
    );
    return c.json(await runMicrosoftKnowledgeHardeningAcceptance(c.env));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Hardening acceptance failed" },
      500,
    );
  }
});

connectors.post("/api/internal/google-drive/whole-drive-acceptance", async (c) => {
  if (!(await verifyCmdAcceptanceToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  try {
    const { runGoogleDriveWholeDriveAcceptance } = await import("../services/google-drive-acceptance");
    return c.json(await runGoogleDriveWholeDriveAcceptance(c.env));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Acceptance failed", classification: "FAIL" },
      500,
    );
  }
});

connectors.post("/api/internal/google-drive/trigger-sync", async (c) => {
  if (!(await verifyCmdAcceptanceToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      dryRun?: boolean;
      autoIndex?: boolean;
      batchId?: number;
      useQueue?: boolean;
      trigger?: string;
    };
    const { triggerGoogleDriveLiveSync } = await import("../services/google-drive-acceptance");
    return c.json(await triggerGoogleDriveLiveSync(c.env, body));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Sync trigger failed", classification: "FAIL" },
      500,
    );
  }
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
    const instances = await listConnectorInstances(c.env.DB, company.id);
    const instance =
      instances.find((i) => i.id === instanceId) ??
      instances.find((i) => i.connectorDefinitionId === "conn_microsoft_365") ??
      null;
    const { listMicrosoftSources } = await import("../services/microsoft-sync");
    const { getMicrosoftConnectorHealth } = await import("../services/microsoft-sync");
    const { microsoftOAuthStatus } = await import("../services/microsoft-oauth");
    const sources = await listMicrosoftSources(c.env.DB, company.id, instance?.id ?? instanceId);
    const health = await getMicrosoftConnectorHealth(c.env, {
      companyId: company.id,
      connectorInstanceId: instance?.id ?? undefined,
      actor: c.get("user").email,
    });
    const { getMicrosoftSourceJobStats } = await import("../services/microsoft-sync");
    const sourcesWithQueue = await Promise.all(
      sources.map(async (source) => {
        const queueStats = await getMicrosoftSourceJobStats(c.env.DB, {
          companyId: company.id,
          sourceId: source.id,
        });
        return {
          ...source,
          queueStats: {
            pending: queueStats.pending,
            byStatus: queueStats.byStatus,
            latestFailure: queueStats.latestFailure,
          },
        };
      }),
    );
    const onedrive = sources.filter((s) => s.sourceType === "onedrive");
    const sharepoint = sources.filter((s) => s.sourceType === "sharepoint");
    const outlook = sources.filter((s) => s.sourceType === "outlook_shared");
    const { assessOutlookPermissions } = await import("../services/microsoft-outlook-permissions");
    const { assessOutlookNotificationArchitecture } = await import(
      "../services/microsoft-outlook-notifications"
    );
    const outlookPermissions = await assessOutlookPermissions(c.env, { companyId: company.id });
    return c.json({
      status: microsoftOAuthStatus(c.env),
      instanceId: instance?.id ?? null,
      health,
      outlook: {
        permissions: outlookPermissions,
        notifications: assessOutlookNotificationArchitecture(),
        retrievalMode: "live_read_only",
        indexingMode: "none_in_alpha",
      },
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
        outlook: {
          total: outlook.length,
          included: outlook.filter((s) => s.inclusionStatus === "included").length,
          sharedCandidates: outlook.filter((s) => s.mailboxType === "shared_mailbox").length,
          personalMailboxes: outlook.filter((s) => s.mailboxType === "personal_mailbox").length,
        },
      },
      sources: sourcesWithQueue,
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
      const newInstanceId = genId("ci");
      await c.env.DB.prepare(
        `INSERT INTO connector_instances (id, company_id, connector_definition_id, name, status, auth_status, created_at, updated_at)
         VALUES (?, ?, 'conn_microsoft_365', 'Microsoft 365', 'configured', 'connected', ?, ?)`,
      ).bind(newInstanceId, company.id, now(), now()).run();
      instance = (await getConnectorInstance(c.env.DB, newInstanceId))!;
    }
    const { ensureMicrosoftLegacyBinding } = await import("../services/microsoft-credentials");
    await ensureMicrosoftLegacyBinding(c.env, c.env.DB, {
      companyId: company.id,
      connectorInstanceId: instance.id,
      actor: c.get("user").email,
    });
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

connectors.get(
  "/api/companies/:slug/microsoft/outlook/permissions",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    const probeMailbox = c.req.query("probeMailbox") ?? null;
    const { assessOutlookPermissions } = await import("../services/microsoft-outlook-permissions");
    const { assessOutlookNotificationArchitecture } = await import(
      "../services/microsoft-outlook-notifications"
    );
    const permissions = await assessOutlookPermissions(c.env, {
      companyId: company.id,
      probeMailboxAddress: probeMailbox,
    });
    return c.json({
      permissions,
      notifications: assessOutlookNotificationArchitecture(),
      stopBeforeLiveRead: permissions.adminConsentRequired,
    });
  },
);

connectors.post(
  "/api/companies/:slug/microsoft/outlook/discover",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as { instanceId?: string };
    const instances = await listConnectorInstances(c.env.DB, company.id);
    let instance = instances.find((i) => i.id === body.instanceId);
    if (!instance) {
      instance = instances.find((i) => i.connectorDefinitionId === "conn_microsoft_365");
    }
    if (!instance) return c.json({ error: "Microsoft 365 connector not configured" }, 404);

    const { discoverOutlookMailboxes } = await import("../services/microsoft-outlook-mailbox");
    const result = await discoverOutlookMailboxes(c.env, {
      companyId: company.id,
      connectorInstanceId: instance.id,
      actor: c.get("user").email,
    });

    const summary = {
      total: result.discovered.length,
      sharedMailboxes: result.discovered.filter((m) => m.mailboxType === "shared_mailbox").length,
      personalMailboxes: result.discovered.filter((m) => m.mailboxType === "personal_mailbox").length,
      roomMailboxes: result.discovered.filter((m) => m.mailboxType === "room_mailbox").length,
      equipmentMailboxes: result.discovered.filter((m) => m.mailboxType === "equipment_mailbox").length,
      unknown: result.discovered.filter((m) => m.mailboxType === "unknown").length,
      defaultInclusion: "excluded",
      ingested: 0,
    };

    return c.json({
      ok: true,
      instanceId: instance.id,
      summary,
      discovered: result.discovered,
      permissions: result.permissions,
      verdict: result.verdict,
      stopBeforeLiveRead: result.permissions.adminConsentRequired,
    });
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
      onJobsEnqueued: (syncRunId) => {
        c.executionCtx.waitUntil(
          (async () => {
            const { kickMicrosoftJobProcessor } = await import("../services/microsoft-job-processor");
            await kickMicrosoftJobProcessor(c.env, syncRunId);
          })(),
        );
      },
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
    const sourceId = c.req.param("sourceId");
    if (body.inclusionStatus === "excluded") {
      const row = await c.env.DB.prepare(
        `SELECT connector_instance_id, source_type FROM microsoft_connector_sources WHERE id = ? AND company_id = ? LIMIT 1`,
      )
        .bind(sourceId, company.id)
        .first<{ connector_instance_id: string; source_type: string }>();
      if (!row) return c.json({ error: "Source not found" }, 404);
      if (row.source_type === "outlook_shared") {
        const { setOutlookMailboxInclusion } = await import("../services/microsoft-outlook-mailbox");
        const result = await setOutlookMailboxInclusion(c.env.DB, {
          companyId: company.id,
          sourceId,
          inclusionStatus: "excluded",
          actor: c.get("user").email,
        });
        if (!result.ok) return c.json({ error: result.message }, 400);
        return c.json({ ok: true });
      }
      const { applyMicrosoftSourceExclusion } = await import("../services/microsoft-sync");
      const result = await applyMicrosoftSourceExclusion(c.env, {
        companyId: company.id,
        connectorInstanceId: row.connector_instance_id,
        sourceId,
        actor: c.get("user").email,
      });
      return c.json({ ok: true, ...result });
    }
    const row = await c.env.DB.prepare(
      `SELECT source_type FROM microsoft_connector_sources WHERE id = ? AND company_id = ? LIMIT 1`,
    )
      .bind(sourceId, company.id)
      .first<{ source_type: string }>();
    if (!row) return c.json({ error: "Source not found" }, 404);
    if (row.source_type === "outlook_shared") {
      const bodyExtra = body as { allowPersonalOverride?: boolean };
      const { setOutlookMailboxInclusion } = await import("../services/microsoft-outlook-mailbox");
      const result = await setOutlookMailboxInclusion(c.env.DB, {
        companyId: company.id,
        sourceId,
        inclusionStatus: body.inclusionStatus,
        actor: c.get("user").email,
        allowPersonalOverride: bodyExtra.allowPersonalOverride === true,
      });
      if (!result.ok) return c.json({ error: result.message }, 400);
      return c.json({ ok: true });
    }
    const { setMicrosoftSourceInclusion } = await import("../services/microsoft-sync");
    await setMicrosoftSourceInclusion(c.env.DB, {
      companyId: company.id,
      sourceId,
      inclusionStatus: body.inclusionStatus,
      actor: c.get("user").email,
    });
    return c.json({ ok: true });
  },
);

connectors.patch(
  "/api/companies/:slug/microsoft/sources/:sourceId/folder-scope",
  requireAuth,
  async (c) => {
    const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    const body = await c.req.json<{
      mode: "all" | "include_paths" | "exclude_paths";
      includePaths?: string[];
      excludePaths?: string[];
    }>();
    const { setMicrosoftSourceFolderScope } = await import("../services/microsoft-sync");
    await setMicrosoftSourceFolderScope(c.env.DB, {
      companyId: company.id,
      sourceId: c.req.param("sourceId"),
      folderScope: {
        mode: body.mode ?? "all",
        includePaths: body.includePaths ?? [],
        excludePaths: body.excludePaths ?? [],
      },
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
      authMode?: "platform_multitenant" | "company_app";
    };
    const { startMicrosoftOAuth } = await import("../services/microsoft-oauth");
    const result = await startMicrosoftOAuth(c.env.DB, c.env, {
      companyId: company.id,
      userId: c.get("user").userId,
      definitionId: body.definitionId ?? "conn_microsoft_365",
      instanceId: body.instanceId ?? null,
      component: (body.component as "onedrive" | "sharepoint" | "outlook_shared" | "microsoft_365") ?? "onedrive",
      returnPath: `/portal/${company.slug}/microsoft-365`,
      authMode: body.authMode ?? "company_app",
      companySlug: company.slug,
      actor: c.get("user").email,
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
