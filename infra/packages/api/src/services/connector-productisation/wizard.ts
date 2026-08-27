/**
 * Connector setup wizard state machine.
 */

import type {
  ConnectorInstance,
  ConnectorSetupStep,
  ConnectorSetupStepId,
  ConnectorSetupStepStatus,
  ConnectorWizardState,
  McpEnvironment,
} from "@infra/shared";
import type { Env } from "../../env";
import { deriveConnectorPresentation } from "../connector-lifecycle";
import { credentialStorageStatus } from "../secrets";
import { xeroOauthStatus } from "../xero";
import { microsoftOAuthStatus } from "../microsoft-oauth";
import { assessConnectorBlockers } from "./blockers";
import { getProductisationProfile } from "./profiles";

function step(
  id: ConnectorSetupStepId,
  title: string,
  description: string,
  status: ConnectorSetupStepStatus,
  extra?: Partial<ConnectorSetupStep>,
): ConnectorSetupStep {
  return { id, title, description, status, ...extra };
}

export function buildConnectorWizardState(input: {
  env: Env;
  companyId: string;
  companySlug: string;
  definitionId: string;
  instance: ConnectorInstance | null;
  mcp: McpEnvironment | null;
}): ConnectorWizardState | null {
  const profile = getProductisationProfile(input.definitionId);
  if (!profile) return null;

  const blockers = assessConnectorBlockers({
    env: input.env,
    companyId: input.companyId,
    companySlug: input.companySlug,
    definitionId: input.definitionId,
    instance: input.instance,
    mcp: input.mcp,
  });
  const hasBlocking = blockers.some((b) => b.severity === "blocking");
  const presentation = input.instance ? deriveConnectorPresentation(input.instance) : null;
  const storage = credentialStorageStatus(input.env);

  const steps: ConnectorSetupStep[] = [];

  for (const stepId of profile.steps) {
    switch (stepId) {
      case "prerequisites": {
        steps.push(
          step(
            "prerequisites",
            "Prerequisites",
            "Platform credential storage and company MCP readiness",
            storage.enabled && (profile.managedBy === "infra" || input.mcp)
              ? "completed"
              : hasBlocking
                ? "blocked"
                : "attention_required",
            {
              detail: storage.enabled
                ? "Credential storage is ready"
                : storage.reason,
            },
          ),
        );
        break;
      }
      case "mcp_managed_notice": {
        steps.push(
          step(
            "mcp_managed_notice",
            "Business MCP setup",
            "Google Drive credentials and sync run on your company Business MCP — not in INFRA.",
            input.mcp ? "completed" : "blocked",
            {
              actionKind: "none",
              detail: input.mcp
                ? `${input.mcp.name} is registered`
                : "Register company Business MCP before Drive knowledge can be indexed",
            },
          ),
        );
        break;
      }
      case "connect": {
        const connected = input.instance?.authStatus === "connected";
        steps.push(
          step(
            "connect",
            "Connect",
            profile.definitionId === "conn_xero"
              ? "Start Xero OAuth from the portal"
              : "Open Microsoft 365 setup",
            connected ? "completed" : hasBlocking ? "blocked" : "available",
            {
              actionLabel: profile.definitionId === "conn_xero" ? "Connect Xero" : "Open setup",
              actionKind: profile.definitionId === "conn_xero" ? "oauth" : "navigate",
              actionTarget:
                profile.portalRoute ? `/portal/${input.companySlug}/${profile.portalRoute}` : null,
            },
          ),
        );
        break;
      }
      case "authorize": {
        const xero = xeroOauthStatus(input.env);
        const ms = microsoftOAuthStatus(input.env);
        const ready =
          profile.definitionId === "conn_xero"
            ? xero.readyToConnect
            : ms.appConfigured;
        const done = input.instance?.authStatus === "connected";
        steps.push(
          step(
            "authorize",
            "Authorize",
            "Sign in with the vendor and grant required permissions",
            done ? "completed" : ready && !hasBlocking ? "available" : "blocked",
            {
              actionLabel: done ? undefined : "Authorize",
              actionKind: profile.definitionId === "conn_xero" ? "oauth" : "navigate",
              actionTarget:
                profile.portalRoute ? `/portal/${input.companySlug}/${profile.portalRoute}` : null,
            },
          ),
        );
        break;
      }
      case "select_account": {
        const orgSelected = Boolean(
          input.instance?.displayAccountName || input.instance?.externalAccountId,
        );
        steps.push(
          step(
            "select_account",
            "Select organisation",
            "Choose the Xero organisation for this company",
            orgSelected ? "completed" : input.instance ? "available" : "locked",
          ),
        );
        break;
      }
      case "discover_sources": {
        const configured = input.instance?.status === "healthy" || input.instance?.lastSyncAt;
        steps.push(
          step(
            "discover_sources",
            "Discover sources",
            "Find OneDrive and SharePoint libraries in your tenant",
            configured ? "completed" : input.instance?.authStatus === "connected" ? "available" : "locked",
            {
              actionLabel: "Discover",
              actionKind: "navigate",
              actionTarget: `/portal/${input.companySlug}/microsoft-365`,
            },
          ),
        );
        break;
      }
      case "configure_scope": {
        steps.push(
          step(
            "configure_scope",
            "Configure scope",
            "Include only approved libraries and folders",
            input.instance?.lastSyncAt ? "completed" : "available",
            {
              actionLabel: "Configure",
              actionKind: "navigate",
              actionTarget: `/portal/${input.companySlug}/microsoft-365`,
            },
          ),
        );
        break;
      }
      case "test_connection": {
        const healthy = input.instance?.healthStatus === "healthy";
        steps.push(
          step(
            "test_connection",
            "Test connection",
            "Verify the connector can reach the provider",
            healthy ? "completed" : input.instance ? "available" : "locked",
            { actionLabel: "Test", actionKind: "test" },
          ),
        );
        break;
      }
      case "activate": {
        const active =
          input.instance?.status === "healthy" &&
          input.instance?.syncSettings?.enabled !== false;
        steps.push(
          step(
            "activate",
            "Activate sync",
            "Enable scheduled sync for included sources",
            active ? "completed" : input.instance ? "available" : "locked",
          ),
        );
        break;
      }
      default:
        break;
    }
  }

  const currentStepId =
    steps.find((s) => s.status === "available" || s.status === "attention_required")?.id ??
    steps.find((s) => s.status === "in_progress")?.id ??
    null;

  return {
    definitionId: profile.definitionId,
    slug: profile.slug,
    instanceId: input.instance?.id ?? null,
    selfServiceLevel: profile.selfServiceLevel,
    currentStepId,
    steps,
    blockers,
    presentation: presentation
      ? {
          authStatus: presentation.authStatus,
          syncHealth: presentation.syncHealth,
          providerHealth: presentation.providerHealth,
          label: presentation.label,
        }
      : null,
  };
}
