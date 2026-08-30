import {
  describeCapability,
  notConfiguredConnectorDefinition,
  readOnlyCapabilities,
  type ConnectorDefinition,
} from "@business-mcp/core";
import { COMPANY_NAME } from "./constants";
import type { Env } from "./env";
import { MICROSOFT_CONNECTOR_CODES, microsoftCredentialsPresent } from "./microsoft/config";

const EL_CONNECTOR_SEEDS: Array<{
  code: string;
  label: string;
  category: string;
  secretName: string;
}> = [
  {
    code: "bigchange",
    label: "BigChange",
    category: "operations",
    secretName: "BIGCHANGE_CREDENTIALS",
  },
  {
    code: "sharepoint",
    label: "SharePoint",
    category: "documents",
    secretName: "EL_MS_CLIENT_SECRET",
  },
  {
    code: "onedrive",
    label: "OneDrive",
    category: "documents",
    secretName: "EL_MS_CLIENT_SECRET",
  },
  {
    code: "xero",
    label: "Xero",
    category: "finance",
    secretName: "XERO_CREDENTIALS",
  },
  {
    code: "outlook_shared_mailbox",
    label: "Outlook Shared Mailbox",
    category: "email",
    secretName: "EL_MS_CLIENT_SECRET",
  },
  {
    code: "outlook_calendar",
    label: "Outlook Calendar",
    category: "calendar",
    secretName: "EL_MS_CLIENT_SECRET",
  },
  {
    code: "freshdesk",
    label: "Freshdesk",
    category: "support",
    secretName: "FRESHDESK_CREDENTIALS",
  },
];

function microsoftConnectorDefinition(
  seed: (typeof EL_CONNECTOR_SEEDS)[number]
): ConnectorDefinition {
  const mailOrCalendar = seed.code === "outlook_shared_mailbox" || seed.code === "outlook_calendar";
  return {
    connectorType: seed.code,
    connectorVersion: "1.1.0",
    company: COMPANY_NAME,
    label: seed.label,
    category: seed.category,
    enabled: true,
    status: "configured",
    authenticationConfigured: true,
    capabilities: mailOrCalendar
      ? [
          ...readOnlyCapabilities(),
          describeCapability("CREATE", true),
          describeCapability("UPDATE", true),
          describeCapability("SEND", seed.code === "outlook_shared_mailbox"),
        ]
      : readOnlyCapabilities(),
    readLevel: "read",
    writeLevel: mailOrCalendar ? "update" : "none",
    sendLevel: seed.code === "outlook_shared_mailbox" ? "send" : "none",
    batchCapable: false,
    health: "healthy",
  };
}

export function elConnectorDefinitions(env?: Env): ConnectorDefinition[] {
  const microsoftReady = env ? microsoftCredentialsPresent(env) : false;
  return EL_CONNECTOR_SEEDS.map((seed) => {
    if (microsoftReady && MICROSOFT_CONNECTOR_CODES.has(seed.code)) {
      return microsoftConnectorDefinition(seed);
    }
    return notConfiguredConnectorDefinition(
      seed.code,
      COMPANY_NAME,
      seed.label,
      seed.category
    );
  });
}

export function elConnectorCapabilitiesCatalog(): Array<{
  connector: string;
  capabilities: ReturnType<typeof describeCapability>[];
}> {
  return EL_CONNECTOR_SEEDS.map((seed) => ({
    connector: seed.code,
    capabilities: [
      describeCapability("READ", false),
      describeCapability("SEARCH", false),
      describeCapability("ANALYSE", false),
      describeCapability("SYNC", false),
      describeCapability("CREATE", false),
      describeCapability("UPDATE", false),
      describeCapability("DELETE", false),
      describeCapability("SEND", false),
      describeCapability("BATCH", false),
      describeCapability("WEBHOOK", false),
    ],
  }));
}

export async function loadConnectorRegistryRows(
  db: D1Database
): Promise<
  Array<{
    code: string;
    label: string;
    category: string;
    status: string;
    notes: string | null;
  }>
> {
  const result = await db
    .prepare(
      "SELECT code, label, category, status, notes FROM connector_registry ORDER BY code"
    )
    .all<{
      code: string;
      label: string;
      category: string;
      status: string;
      notes: string | null;
    }>();
  return result.results;
}

export { EL_CONNECTOR_SEEDS };
