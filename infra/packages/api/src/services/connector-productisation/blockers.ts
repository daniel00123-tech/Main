/**
 * Assess connector self-service blockers per company.
 */

import type {
  CompanyConnectorProductisationReport,
  ConnectorBlocker,
  ConnectorInstance,
  ConnectorProductisationAssessment,
  McpEnvironment,
} from "@infra/shared";
import type { Env } from "../../env";
import { credentialStorageStatus } from "../secrets";
import { xeroOauthStatus } from "../xero";
import { microsoftOAuthStatus } from "../microsoft-oauth";
import {
  inferMicrosoftAuthMode,
  platformMultitenantAppEnabled,
  platformMicrosoftConfigured,
} from "../microsoft-credentials";
import { getProductisationProfile, listProductisationProfiles } from "./profiles";
import { CONNECTOR_CATALOGUE, getConnectorById } from "@infra/shared";

function classify(level: string, blockers: ConnectorBlocker[]): "pass" | "partial" | "fail" {
  const blocking = blockers.filter((b) => b.severity === "blocking");
  if (blocking.length === 0 && level === "full") return "pass";
  if (blocking.length === 0 && (level === "partial" || level === "mcp_managed")) return "partial";
  if (blocking.length === 0) return "partial";
  return "fail";
}

export function assessConnectorBlockers(input: {
  env: Env;
  companyId: string;
  companySlug: string;
  definitionId: string;
  instance: ConnectorInstance | null;
  mcp: McpEnvironment | null;
}): ConnectorBlocker[] {
  const profile = getProductisationProfile(input.definitionId);
  const definition = getConnectorById(input.definitionId);
  if (!profile || !definition) return [];

  const blockers: ConnectorBlocker[] = [];
  const storage = credentialStorageStatus(input.env);

  if (!storage.enabled) {
    blockers.push({
      code: "CREDENTIAL_STORAGE_DISABLED",
      message: storage.reason,
      severity: "blocking",
      remediation: "Platform operator must configure INFRA_CREDENTIAL_WRAPPING_KEY",
    });
  }

  if (profile.managedBy === "company_mcp") {
    if (!input.mcp) {
      blockers.push({
        code: "MCP_NOT_PROVISIONED",
        message: "Company Business MCP is not registered",
        severity: "blocking",
        remediation: "Platform operator must register the company MCP environment",
      });
    } else if (!input.mcp.authSecretRef) {
      blockers.push({
        code: "MCP_AUTH_NOT_CONFIGURED",
        message: "Business MCP authentication is not configured",
        severity: "blocking",
        remediation: "Configure MCP auth secret reference on the Worker",
      });
    }
    blockers.push({
      code: "MCP_MANAGED_CONNECTOR",
      message:
        "Google Drive is configured on the company Business MCP. INFRA shows health and document counts only.",
      severity: "info",
      remediation: "Complete Drive setup on the Business MCP Worker",
    });
    return blockers;
  }

  if (input.definitionId === "conn_xero") {
    const xero = xeroOauthStatus(input.env);
    if (!xero.appConfigured) {
      blockers.push({
        code: "XERO_APP_NOT_CONFIGURED",
        message: "Xero OAuth application is not configured on the platform",
        severity: "blocking",
        remediation: "Platform operator must set XERO_CLIENT_ID and XERO_CLIENT_SECRET",
      });
    }
    if (!xero.storageEnabled) {
      blockers.push({
        code: "XERO_STORAGE_DISABLED",
        message: "Encrypted credential storage is required for Xero tokens",
        severity: "blocking",
      });
    }
    if (input.mcp && !input.mcp.authSecretRef) {
      blockers.push({
        code: "MCP_AUTH_NOT_CONFIGURED",
        message: "Xero tools require a registered Business MCP with auth configured",
        severity: "warning",
        remediation: "Register company MCP so AI clients can execute Xero tools",
      });
    }
    return blockers;
  }

  if (input.definitionId === "conn_microsoft_365") {
    const ms = microsoftOAuthStatus(input.env);
    const binding = input.instance
      ? {
          instanceId: input.instance.id,
          companyId: input.companyId,
          authMode: null,
          tenantId: input.instance.externalAccountId ?? null,
          credentialRefId: input.instance.credentialRefId ?? null,
          authStatus: input.instance.authStatus ?? null,
          consentedAt: null,
          consentedBy: null,
        }
      : null;
    const authMode = inferMicrosoftAuthMode(input.env, binding);
    const connected = input.instance?.authStatus === "connected";
    const tenantBound = Boolean(binding?.tenantId ?? input.instance?.externalAccountId);

    if (!ms.appConfigured && authMode !== "company_app") {
      blockers.push({
        code: "MICROSOFT_APP_NOT_CONFIGURED",
        message: "Microsoft 365 platform application is not configured",
        severity: "blocking",
        remediation: "Platform operator must configure MICROSOFT_* Worker secrets or use BYO Entra app credentials",
      });
    }

    if (authMode === "platform_legacy") {
      blockers.push({
        code: "MICROSOFT_PLATFORM_LEGACY",
        message: "This company uses the legacy platform Microsoft tenant (production-safe path).",
        severity: "info",
      });
    } else if (connected && tenantBound) {
      blockers.push({
        code: "MICROSOFT_SELF_SERVICE_READY",
        message: `Microsoft 365 connected (${authMode ?? "unknown"}). SharePoint and OneDrive onboarding available.`,
        severity: "info",
      });
    } else if (authMode === "company_app" && input.instance?.credentialRefId && !connected) {
      blockers.push({
        code: "MICROSOFT_ADMIN_CONSENT_REQUIRED",
        message: "Entra app credentials stored. Complete admin consent to bind your tenant.",
        severity: "blocking",
        remediation: "Portal → Microsoft 365 → Connect → grant admin consent",
      });
    } else if (!platformMultitenantAppEnabled(input.env) && !input.instance?.credentialRefId) {
      blockers.push({
        code: "MICROSOFT_MULTITENANT_ENTRA_MANUAL",
        message:
          "Platform multi-tenant SaaS onboarding requires Daniel to configure the Entra app (supported account types, redirect URI, publisher verification) and set MICROSOFT_MULTITENANT_APP=true.",
        severity: "blocking",
        remediation:
          "Use BYO Entra app credentials (company_app) for self-service today, or complete platform Entra configuration",
      });
    }
    if (!connected && !blockers.some((b) => b.code === "MICROSOFT_ADMIN_CONSENT_REQUIRED")) {
      blockers.push({
        code: "MICROSOFT_NOT_CONNECTED",
        message: "Microsoft 365 is not connected for this company.",
        severity: "blocking",
        remediation: "Portal → Systems → Microsoft 365 → Connect",
      });
    }

    if (platformMicrosoftConfigured(input.env) && !platformMultitenantAppEnabled(input.env)) {
      blockers.push({
        code: "MICROSOFT_ENTRA_MULTITENANT_PENDING",
        message:
          "INFRA multi-tenant admin consent flow is implemented but awaiting operator Entra configuration.",
        severity: "info",
        remediation: "Daniel: convert app to multi-tenant, add redirect URI, grant admin consent template",
      });
    }

    if (input.mcp) {
      const adminRef = input.mcp.adminSecretRef ?? "CADDINGTON_ADMIN_TOKEN";
      const adminConfigured = Boolean(
        (input.env as Record<string, unknown>)[adminRef] ??
          (input.env as Record<string, unknown>).CADDINGTON_ADMIN_TOKEN,
      );
      if (!adminConfigured) {
        blockers.push({
          code: "MCP_ADMIN_BRIDGE_MISSING",
          message: "Knowledge indexing bridge admin token is not configured",
          severity: "warning",
          remediation: `Set Worker secret for ${adminRef} or seed mcp_environments.admin_secret_ref`,
        });
      }
    }
    return blockers;
  }

  return blockers;
}

export function buildCompanyProductisationReport(input: {
  env: Env;
  companyId: string;
  companySlug: string;
  connectors: ConnectorInstance[];
  mcp: McpEnvironment | null;
}): CompanyConnectorProductisationReport {
  const storage = credentialStorageStatus(input.env);
  const assessments: ConnectorProductisationAssessment[] = [];

  for (const profile of listProductisationProfiles()) {
    const definition = CONNECTOR_CATALOGUE.find((c) => c.id === profile.definitionId);
    if (!definition) continue;
    const instance =
      input.connectors.find((c) => c.connectorDefinitionId === profile.definitionId) ?? null;
    const blockers = assessConnectorBlockers({
      env: input.env,
      companyId: input.companyId,
      companySlug: input.companySlug,
      definitionId: profile.definitionId,
      instance,
      mcp: input.mcp,
    });
    assessments.push({
      definitionId: profile.definitionId,
      slug: profile.slug,
      name: definition.name,
      selfServiceLevel: profile.selfServiceLevel,
      classification: classify(profile.selfServiceLevel, blockers),
      blockers,
      wizardAvailable: profile.selfServiceLevel !== "not_available",
    });
  }

  const overall =
    assessments.every((a) => a.classification === "pass")
      ? "pass"
      : assessments.some((a) => a.classification === "pass" || a.classification === "partial")
        ? "partial"
        : "fail";

  return {
    companyId: input.companyId,
    companySlug: input.companySlug,
    mcpProvisioned: Boolean(input.mcp),
    credentialStorageReady: storage.enabled,
    connectors: assessments,
    overall,
  };
}
