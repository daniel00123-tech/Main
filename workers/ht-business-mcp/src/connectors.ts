import {
  notConfiguredConnectorDefinition,
  type ConnectorDefinition,
} from "@business-mcp/core";
import { COMPANY_NAME } from "./constants";

const HT_CONNECTOR_SEEDS: Array<{
  code: string;
  label: string;
  category: string;
}> = [
  { code: "commusoft", label: "Commusoft", category: "operations" },
  { code: "sharepoint", label: "SharePoint", category: "documents" },
  { code: "onedrive", label: "OneDrive", category: "documents" },
  { code: "xero", label: "Xero", category: "finance" },
  { code: "outlook_shared_mailbox", label: "Outlook Shared Mailbox", category: "email" },
];

export function htConnectorDefinitions(): ConnectorDefinition[] {
  return HT_CONNECTOR_SEEDS.map((seed) =>
    notConfiguredConnectorDefinition(
      seed.code,
      COMPANY_NAME,
      seed.label,
      seed.category
    )
  );
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
  try {
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
  } catch {
    return [];
  }
}
