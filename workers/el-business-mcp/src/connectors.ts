import {
  describeCapability,
  notConfiguredConnectorDefinition,
  type ConnectorDefinition,
} from "@business-mcp/core";
import { COMPANY_NAME } from "./constants";

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
    secretName: "MICROSOFT_SHAREPOINT_CREDENTIALS",
  },
  {
    code: "onedrive",
    label: "OneDrive",
    category: "documents",
    secretName: "MICROSOFT_ONEDRIVE_CREDENTIALS",
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
    secretName: "OUTLOOK_SHARED_MAILBOX_CREDENTIALS",
  },
  {
    code: "freshdesk",
    label: "Freshdesk",
    category: "support",
    secretName: "FRESHDESK_CREDENTIALS",
  },
];

export function elConnectorDefinitions(): ConnectorDefinition[] {
  return EL_CONNECTOR_SEEDS.map((seed) =>
    notConfiguredConnectorDefinition(
      seed.code,
      COMPANY_NAME,
      seed.label,
      seed.category
    )
  );
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
