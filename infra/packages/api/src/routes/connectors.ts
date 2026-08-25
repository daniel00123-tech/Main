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
  createOauthAuthorizationState,
  consumeOauthAuthorizationState,
  oauthProviderNotActivated,
} from "../services/connector-oauth";
import {
  rejectPlaintextCredentialStore,
  rotateConnectorCredential,
  sanitizeConnectorConfig,
  storeConnectorCredential,
} from "../services/connector-credentials";
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

    if (body.credentials && Object.keys(body.credentials).length > 0) {
      return c.json(rejectPlaintextCredentialStore().body, 409);
    }

    const id = newId("ci");
    const now = nowIso();
    const safeConfig = sanitizeConnectorConfig(body.config);
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

    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "connector.instance_created",
      actor: c.get("user").email,
      resourceType: "connector",
      resourceId: id,
      detail: { definitionId: definition.id, credentialStored: false },
    });

    return c.json({
      id,
      companyId: company.id,
      connectorDefinitionId: definition.id,
      status: "draft",
      authStatus: "credentials_required",
      credentialSubmission: "disabled",
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
      label?: string;
    }>().catch(() => ({ secretValue: undefined, label: undefined }));
    if (!body.secretValue) {
      return c.json(rejectPlaintextCredentialStore().body, 409);
    }
    const stored = await storeConnectorCredential({
      env: c.env,
      companyId: company.id,
      instanceId: instance.id,
      label: body.label ?? "Primary credential",
      provider: instance.connectorDefinitionId,
      secretValue: body.secretValue,
      actor: c.get("user").email,
    });
    if (!stored.ok) return c.json(stored.body, stored.status);
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "connector.connected",
      actor: c.get("user").email,
      resourceType: "connector",
      resourceId: instance.id,
      detail: { credentialRefId: stored.credentialRefId },
    });
    return c.json({ ok: true, credentialRefId: stored.credentialRefId });
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
      credentialRefId?: string;
    }>().catch(() => ({ secretValue: undefined, credentialRefId: undefined }));
    const credentialRefId = body.credentialRefId ?? instance.credentialRefId;
    if (!credentialRefId || !body.secretValue) {
      return c.json(rejectPlaintextCredentialStore().body, 409);
    }
    const rotated = await rotateConnectorCredential({
      env: c.env,
      companyId: company.id,
      instanceId: instance.id,
      credentialRefId,
      secretValue: body.secretValue,
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

    const state = await createOauthAuthorizationState(c.env.DB, {
      companyId: company.id,
      userId: c.get("user").userId,
      definitionId: definition.id,
    });
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
        stateIssued: true,
        expiresAt: state.expiresAt,
        pkce: "S256",
      },
      409,
    );
  },
);

connectors.get("/api/connectors/oauth/callback", requireAuth, async (c) => {
  const state = c.req.query("state") ?? "";
  const consumed = await consumeOauthAuthorizationState(c.env.DB, {
    state,
    userId: c.get("user").userId,
  });
  if (!consumed.ok) return c.json(consumed.error, 400);
  if (!userHasCompanyAccess(c.get("user"), consumed.companyId)) {
    return c.json(customerConnectorError(CONNECTOR_ERROR_CODES.OAUTH_STATE_INVALID), 403);
  }
  await recordAuditEvent(c.env.DB, {
    companyId: consumed.companyId,
    eventType: "connector.connection_failed",
    actor: c.get("user").email,
    resourceType: "connector",
    resourceId: consumed.definitionId,
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

export default connectors;
