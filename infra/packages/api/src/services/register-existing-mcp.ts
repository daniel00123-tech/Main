import type { Company } from "@infra/shared";
import { newId, nowIso, rowToCompany, rowToMcpEnvironment } from "../db/mappers";
import { getConnectorBySlug } from "@infra/shared";
import {
  recordAuditEvent,
  validateRegisteredMcpEndpoint,
} from "./control-plane";
import { provisionCompany } from "./tenant-provisioning";

export type PlannedConnectorSeed = {
  slug: string;
  instanceName: string;
};

export type ExistingCompanyMcpSpec = {
  preferredCompanyId: string;
  legalName: string;
  tradingName: string;
  slug: string;
  portalSubdomain: string;
  notes: string;
  openingCreditCents: number;
  mcp: {
    id: string;
    name: string;
    description: string;
    endpointUrl: string;
    dataPlaneId: string;
    authSecretRef: string;
    serviceBindingRef: string;
    mcpVersion: string | null;
    coreVersion: string | null;
    knowledgeStatus: "not_configured" | "indexed";
    warehouseStatus: "configured" | "not_configured";
    /** Honest initial capabilities until authenticated tools/list succeeds. */
    initialCapabilities: string[];
  };
  plannedConnectors: PlannedConnectorSeed[];
};

/**
 * Known existing production Business MCPs to attach — never create replacement Workers.
 * Company #4 later should use registerExistingMcpEnvironment() with its own URL/secret ref.
 */
export const EXISTING_PRODUCTION_COMPANY_MCPS: ExistingCompanyMcpSpec[] = [
  {
    preferredCompanyId: "co_ht",
    legalName: "HT Business",
    tradingName: "HT Business",
    slug: "ht-business",
    portalSubdomain: "ht",
    notes:
      "Existing HT Business MCP attached. Knowledge (R2/Vectorize) not configured. Warehouse/D1 present.",
    openingCreditCents: 1000,
    mcp: {
      id: "mcp_ht_primary",
      name: "HT Business MCP",
      description:
        "Existing HT Business MCP Worker. Knowledge not configured; structured warehouse data lives in ht-business-data.",
      endpointUrl: "https://ht-business-mcp.daniel-dwyer123.workers.dev/mcp",
      dataPlaneId: "dp_ht_business",
      authSecretRef: "HT_MCP_AUTH_TOKEN",
      serviceBindingRef: "HT_BUSINESS_MCP",
      mcpVersion: "0.2.1",
      coreVersion: "1.0.0",
      knowledgeStatus: "not_configured",
      warehouseStatus: "configured",
      initialCapabilities: ["system_health", "database_summary"],
    },
    plannedConnectors: [
      { slug: "commusoft", instanceName: "Commusoft" },
      { slug: "sharepoint", instanceName: "SharePoint" },
      { slug: "onedrive", instanceName: "OneDrive" },
      { slug: "xero", instanceName: "Xero" },
      { slug: "outlook-shared-mailbox", instanceName: "Outlook Shared Mailbox" },
    ],
  },
  {
    preferredCompanyId: "co_el",
    legalName: "EL Business",
    tradingName: "EL Business",
    slug: "el-business",
    portalSubdomain: "el",
    notes:
      "Existing EL Business MCP attached. Knowledge not configured. Entity warehouse framework present, no operational records yet.",
    openingCreditCents: 1000,
    mcp: {
      id: "mcp_el_primary",
      name: "EL Business MCP",
      description:
        "Existing EL Business MCP Worker. Knowledge not configured; no live business-system connectors.",
      endpointUrl: "https://el-business-mcp.daniel-dwyer123.workers.dev/mcp",
      dataPlaneId: "dp_el_business",
      authSecretRef: "EL_MCP_AUTH_TOKEN",
      serviceBindingRef: "EL_BUSINESS_MCP",
      mcpVersion: "1.0.0",
      coreVersion: "1.0.0",
      knowledgeStatus: "not_configured",
      warehouseStatus: "not_configured",
      initialCapabilities: ["system_health"],
    },
    plannedConnectors: [
      { slug: "bigchange", instanceName: "BigChange" },
      { slug: "sharepoint", instanceName: "SharePoint" },
      { slug: "onedrive", instanceName: "OneDrive" },
      { slug: "xero", instanceName: "Xero" },
      { slug: "outlook-shared-mailbox", instanceName: "Outlook Shared Mailbox" },
      { slug: "freshdesk", instanceName: "Freshdesk" },
    ],
  },
];

export async function registerExistingMcpEnvironment(
  db: D1Database,
  input: {
    id?: string;
    companyId: string;
    name: string;
    description?: string;
    endpointUrl: string;
    authSecretRef: string;
    serviceBindingRef?: string | null;
    dataPlaneId?: string | null;
    mcpVersion?: string | null;
    coreVersion?: string | null;
    actor: string;
    environment?: string;
    initialCapabilities?: string[];
  },
) {
  const validation = validateRegisteredMcpEndpoint(
    input.endpointUrl,
    input.environment ?? "production",
  );
  if (!validation.valid) {
    throw new Error(validation.reason ?? "Invalid MCP endpoint");
  }

  if (!input.authSecretRef.trim()) {
    throw new Error("authSecretRef is required (Worker secret name, not the token)");
  }
  if (input.authSecretRef.includes(" ") || input.authSecretRef.includes("/")) {
    throw new Error("authSecretRef must be a Worker secret binding name");
  }

  const existingEndpoint = await db
    .prepare(
      `SELECT id, company_id FROM mcp_environments WHERE lower(endpoint_url) = lower(?)`,
    )
    .bind(input.endpointUrl)
    .first();
  if (
    existingEndpoint &&
    String(existingEndpoint.company_id) !== input.companyId
  ) {
    throw new Error("That MCP endpoint is already registered to another company");
  }

  const now = nowIso();
  const id = existingEndpoint
    ? String(existingEndpoint.id)
    : input.id?.trim() || newId("mcp");

  if (existingEndpoint) {
    await db
      .prepare(
        `UPDATE mcp_environments
         SET name = ?, description = ?, auth_secret_ref = ?, service_binding_ref = ?,
             data_plane_id = ?, mcp_version = ?, business_mcp_core_version = ?,
             enabled = 1, is_external = 1, updated_at = ?
         WHERE id = ? AND company_id = ?`,
      )
      .bind(
        input.name,
        input.description ?? null,
        input.authSecretRef,
        input.serviceBindingRef ?? null,
        input.dataPlaneId ?? null,
        input.mcpVersion ?? null,
        input.coreVersion ?? null,
        now,
        id,
        input.companyId,
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO mcp_environments (
          id, company_id, name, description, endpoint_url, transport, status,
          enabled, is_external, data_plane_id, mcp_version, business_mcp_core_version,
          capabilities_json, auth_secret_ref, service_binding_ref,
          last_health_check_at, last_healthy_at, health_message,
          created_at, updated_at
        )         VALUES (?, ?, ?, ?, ?, 'streamable-http', 'registered', 1, 1, ?, ?, ?, ?, ?, ?,
          NULL, NULL, 'Awaiting first authenticated health check', ?, ?)`,
      )
      .bind(
        id,
        input.companyId,
        input.name,
        input.description ?? null,
        input.endpointUrl,
        input.dataPlaneId ?? null,
        input.mcpVersion ?? null,
        input.coreVersion ?? null,
        JSON.stringify(input.initialCapabilities ?? []),
        input.authSecretRef,
        input.serviceBindingRef ?? null,
        now,
        now,
      )
      .run();
  }

  await db
    .prepare(
      `UPDATE companies
       SET mcp_onboarding_status = 'registered', updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, input.companyId)
    .run();

  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "mcp.registered",
    actor: input.actor,
    resourceType: "mcp",
    resourceId: id,
    detail: {
      name: input.name,
      endpoint: input.endpointUrl,
      authSecretRef: input.authSecretRef,
      serviceBindingRef: input.serviceBindingRef ?? null,
      isExternal: true,
    },
  });

  const row = await db
    .prepare("SELECT * FROM mcp_environments WHERE id = ?")
    .bind(id)
    .first();
  if (!row) throw new Error("Failed to load registered MCP");
  return rowToMcpEnvironment(row);
}

export async function seedPlannedConnectorInstances(
  db: D1Database,
  companyId: string,
  connectors: PlannedConnectorSeed[],
  actor: string,
) {
  const now = nowIso();
  for (const item of connectors) {
    const definition = getConnectorBySlug(item.slug);
    if (!definition) continue;
    const existing = await db
      .prepare(
        `SELECT id FROM connector_instances
         WHERE company_id = ? AND connector_definition_id = ?`,
      )
      .bind(companyId, definition.id)
      .first();
    if (existing) continue;

    const id = newId("ci");
    await db
      .prepare(
        `INSERT INTO connector_instances (
          id, company_id, connector_definition_id, name, status, config_json, sync_settings_json,
          data_environment_id, last_sync_at, last_sync_status, last_sync_message,
          health_status, health_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, NULL, NULL, NULL, 'Not connected — planned',
          'unknown', 'Not configured', ?, ?)`,
      )
      .bind(
        id,
        companyId,
        definition.id,
        item.instanceName,
        JSON.stringify({
          note: "Registry only. Do not mark Connected until the company MCP integration is live.",
        }),
        JSON.stringify({ enabled: false, mode: "manual", schedule: null }),
        now,
        now,
      )
      .run();

    await recordAuditEvent(db, {
      companyId,
      eventType: "connector.registered",
      actor,
      resourceType: "connector",
      resourceId: id,
      detail: { slug: item.slug, status: "draft" },
    });
  }
}

export async function provisionOrReuseCompany(
  db: D1Database,
  spec: ExistingCompanyMcpSpec,
  actorEmail: string,
): Promise<Company> {
  const existing = await db
    .prepare("SELECT * FROM companies WHERE id = ? OR slug = ?")
    .bind(spec.preferredCompanyId, spec.slug)
    .first();
  if (existing) return rowToCompany(existing);

  const created = await provisionCompany(
    db,
    {
      legalName: spec.legalName,
      tradingName: spec.tradingName,
      slug: spec.slug,
      portalSubdomain: spec.portalSubdomain,
      notes: spec.notes,
      openingCreditCents: spec.openingCreditCents,
      currency: "GBP",
    },
    actorEmail,
    {
      preferredId: spec.preferredCompanyId,
      openingCreditDescription: `£10.00 TEST CREDIT (internal/test) for ${spec.legalName}`,
      openingCreditMetadata: {
        provisioned: true,
        testCredit: true,
        label: "TEST CREDIT",
      },
    },
  );

  return created.company;
}

export async function attachExistingCompanyMcp(
  db: D1Database,
  spec: ExistingCompanyMcpSpec,
  actorEmail: string,
) {
  const company = await provisionOrReuseCompany(db, spec, actorEmail);

  const mcp = await registerExistingMcpEnvironment(db, {
    id: spec.mcp.id,
    companyId: company.id,
    name: spec.mcp.name,
    description: spec.mcp.description,
    endpointUrl: spec.mcp.endpointUrl,
    authSecretRef: spec.mcp.authSecretRef,
    serviceBindingRef: spec.mcp.serviceBindingRef,
    dataPlaneId: spec.mcp.dataPlaneId,
    mcpVersion: spec.mcp.mcpVersion,
    coreVersion: spec.mcp.coreVersion,
    actor: actorEmail,
    initialCapabilities: spec.mcp.initialCapabilities,
  });

  await seedPlannedConnectorInstances(
    db,
    company.id,
    spec.plannedConnectors,
    actorEmail,
  );

  return { company, mcp };
}
