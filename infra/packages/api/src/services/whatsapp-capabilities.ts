import type { Env } from "../env";

type ConnectorRow = {
  connector_definition_id: string;
  name: string | null;
  status: string | null;
  auth_status: string | null;
};

const CAPABILITY_BY_CONNECTOR: Record<string, string> = {
  conn_microsoft_365: "company emails, OneDrive and SharePoint",
  conn_sharepoint: "SharePoint",
  conn_onedrive: "OneDrive",
  conn_outlook_shared: "shared mailboxes",
  conn_xero: "permitted Xero information",
  conn_bigchange: "BigChange jobs and operational data",
  conn_commusoft: "Commusoft jobs and operational data",
  conn_google_drive: "Google Drive files",
  conn_freshdesk: "Freshdesk tickets",
};

export async function listConnectedConnectorIds(env: Env, companyId: string): Promise<string[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT connector_definition_id
       FROM connector_instances
       WHERE company_id = ?
         AND auth_status = 'connected'
         AND COALESCE(status, '') NOT IN ('disabled', 'draft', 'archived')`,
    )
      .bind(companyId)
      .all<{ connector_definition_id: string }>();
    return (rows.results ?? []).map((row) => row.connector_definition_id);
  } catch {
    return [];
  }
}

export async function listConnectedCapabilityLabels(env: Env, companyId: string): Promise<string[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT connector_definition_id, name, status, auth_status
       FROM connector_instances
       WHERE company_id = ?
         AND auth_status = 'connected'
         AND COALESCE(status, '') NOT IN ('disabled', 'draft', 'archived')`,
    )
      .bind(companyId)
      .all<ConnectorRow>();
    const labels = new Set<string>();
    for (const row of rows.results ?? []) {
      const label = CAPABILITY_BY_CONNECTOR[row.connector_definition_id];
      if (label) labels.add(label);
    }
    return [...labels];
  } catch {
    return [];
  }
}

export function formatCapabilityReply(labels: string[]): string {
  const intro =
    "I can help you search documents and emails, check business information, summarise things and work with your connected systems.";
  if (!labels.length) {
    return `${intro} I will only use systems that are connected and that you are allowed to access.`;
  }
  const listed =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
  return `${intro}\nI currently have access to ${listed}.`;
}

export function formatPricingCapabilityReply(labels: string[]): string {
  const hasKnowledge = labels.some((label) =>
    /email|OneDrive|SharePoint|document|Drive|Xero|BigChange|Commusoft/i.test(label),
  );
  if (hasKnowledge) {
    return "Yes — if your company has the relevant pricing information connected, I can help find rates, materials, historical job information and supporting documents to help price the job.";
  }
  return "I can only use the systems that are currently connected for your company. I don’t currently have a pricing source connected, but I can search any documents or records you do have access to.";
}

export async function capabilityReplyForCompany(env: Env, companyId: string): Promise<string> {
  return formatCapabilityReply(await listConnectedCapabilityLabels(env, companyId));
}
