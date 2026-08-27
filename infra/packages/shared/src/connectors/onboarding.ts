/**
 * Connector productisation — reusable self-service onboarding contracts.
 */

export const CONNECTOR_SETUP_STEP_IDS = [
  "prerequisites",
  "connect",
  "authorize",
  "select_account",
  "discover_sources",
  "configure_scope",
  "test_connection",
  "activate",
  "mcp_managed_notice",
] as const;

export type ConnectorSetupStepId = (typeof CONNECTOR_SETUP_STEP_IDS)[number];

export type ConnectorSetupStepStatus =
  | "locked"
  | "available"
  | "in_progress"
  | "completed"
  | "attention_required"
  | "blocked"
  | "not_applicable";

export type ConnectorSetupStep = {
  id: ConnectorSetupStepId;
  title: string;
  description: string;
  status: ConnectorSetupStepStatus;
  actionLabel?: string | null;
  actionKind?: "oauth" | "navigate" | "refresh" | "test" | "none";
  actionTarget?: string | null;
  detail?: string | null;
};

export type ConnectorSelfServiceLevel =
  | "full"
  | "partial"
  | "operator_required"
  | "mcp_managed"
  | "not_available";

export type ConnectorProductisationProfile = {
  definitionId: string;
  slug: string;
  selfServiceLevel: ConnectorSelfServiceLevel;
  managedBy: "infra" | "company_mcp";
  steps: ConnectorSetupStepId[];
  portalRoute?: string | null;
};

export type ConnectorBlocker = {
  code: string;
  message: string;
  severity: "info" | "warning" | "blocking";
  remediation?: string | null;
};

export type ConnectorProductisationAssessment = {
  definitionId: string;
  slug: string;
  name: string;
  selfServiceLevel: ConnectorSelfServiceLevel;
  classification: "pass" | "partial" | "fail";
  blockers: ConnectorBlocker[];
  wizardAvailable: boolean;
};

export type ConnectorWizardState = {
  definitionId: string;
  slug: string;
  instanceId: string | null;
  selfServiceLevel: ConnectorSelfServiceLevel;
  currentStepId: ConnectorSetupStepId | null;
  steps: ConnectorSetupStep[];
  blockers: ConnectorBlocker[];
  presentation: {
    authStatus: string;
    syncHealth: string;
    providerHealth: string;
    label: string;
  } | null;
};

export type CompanyConnectorProductisationReport = {
  companyId: string;
  companySlug: string;
  mcpProvisioned: boolean;
  credentialStorageReady: boolean;
  connectors: ConnectorProductisationAssessment[];
  overall: "pass" | "partial" | "fail";
};
