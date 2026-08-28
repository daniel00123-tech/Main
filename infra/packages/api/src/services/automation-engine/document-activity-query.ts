/**
 * Read-only document activity from existing INFRA / MCP knowledge metadata.
 * Does not trigger Google Drive scans or Microsoft/Outlook syncs.
 */

import {
  classifyDocumentActivity,
  documentActivityLineSourceLabel,
  documentActivitySourceLabel,
  isOutlookAttachmentItem,
  rolling24hWindow,
  type ClassifiedActivityDocument,
  type DocumentActivitySourceCount,
  type DocumentActivitySourceKey,
} from "@infra/shared";
import type { Env } from "../../env";
import type { McpEnvironment } from "@infra/shared";
import { getCompanyById, listMcpEnvironments } from "../control-plane";
import { resolveMcpAdminAuthHeader } from "../mcp-admin-bridge";
import { resolveMcpFetcher } from "../mcp-client";

export type DocumentActivityReport = {
  companyId: string;
  windowFrom: string;
  windowTo: string;
  sourceCounts: DocumentActivitySourceCount[];
  totalCount: number;
  newDocuments: ClassifiedActivityDocument[];
  updatedDocuments: ClassifiedActivityDocument[];
  canDistinguishNewUpdated: true;
  sourcesQueried: string[];
  sourcesUnavailable: string[];
  triggeredProviderScan: false;
};

type MicrosoftKnowledgeRow = {
  title: string;
  source_type: string;
  knowledge_document_id: number | null;
  created_at: string | null;
  modified_at: string | null;
  external_id: string | null;
  external_item_id: string | null;
  provenance_json: string | null;
};

type McpActivityDocument = {
  title?: string;
  source?: string | null;
  category?: string | null;
  createdAt?: string | null;
  driveModifiedTime?: string | null;
};

type McpActivityResponse = {
  ok?: boolean;
  googleDriveUniqueCount?: number;
  documents?: McpActivityDocument[];
};

function parseProvenance(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function fetchMcpDocumentActivity(
  env: Env,
  mcp: McpEnvironment,
  windowFrom: Date,
  windowTo: Date,
): Promise<McpActivityResponse | null> {
  const auth = resolveMcpAdminAuthHeader(env, mcp);
  if (!auth.authorizationHeader) return null;

  const binding = resolveMcpFetcher(env, mcp.serviceBindingRef ?? "CADDINGTON_MCP");
  const path = `/admin/knowledge/activity?since=${encodeURIComponent(windowFrom.toISOString())}&until=${encodeURIComponent(windowTo.toISOString())}`;
  const headers = { Authorization: auth.authorizationHeader };
  const url = `https://company-mcp.internal${path}`;

  try {
    const response = binding
      ? await binding.fetch(new Request(url, { headers }))
      : await fetch(`${mcp.endpointUrl.replace(/\/mcp\/?$/, "")}${path}`, { headers });
    if (!response.ok) return null;
    return (await response.json()) as McpActivityResponse;
  } catch {
    return null;
  }
}

export async function queryDocumentActivity(
  env: Env,
  companyId: string,
  now = new Date(),
): Promise<DocumentActivityReport> {
  const company = await getCompanyById(env.DB, companyId);
  if (!company) {
    throw new Error("Company not found");
  }

  const window = rolling24hWindow(now);
  const sourcesUnavailable: string[] = [];
  const sourcesQueried: string[] = [];

  let microsoftRows: MicrosoftKnowledgeRow[] = [];
  try {
    const result = await env.DB.prepare(
      `SELECT title, source_type, knowledge_document_id, created_at, modified_at,
              external_id, external_item_id, provenance_json
       FROM microsoft_knowledge_items
       WHERE company_id = ?
         AND COALESCE(visibility_status, 'active') = 'active'
         AND knowledge_document_id IS NOT NULL`,
    )
      .bind(companyId)
      .all<MicrosoftKnowledgeRow>();
    microsoftRows = result.results ?? [];
    sourcesQueried.push("microsoft_knowledge_items");
  } catch {
    sourcesUnavailable.push("microsoft_knowledge_items");
  }

  const mcps = await listMcpEnvironments(env.DB, companyId);
  const mcp = mcps[0] ?? null;
  let mcpActivity: McpActivityResponse | null = null;
  if (mcp) {
    mcpActivity = await fetchMcpDocumentActivity(env, mcp, window.from, window.to);
    if (mcpActivity?.ok) sourcesQueried.push("mcp_knowledge_documents");
    else sourcesUnavailable.push("mcp_knowledge_documents");
  } else {
    sourcesUnavailable.push("mcp_knowledge_documents");
  }

  if (sourcesQueried.length === 0) {
    throw new Error("DOCUMENT_STORE_UNAVAILABLE");
  }

  const counts = new Map<DocumentActivitySourceKey, number>();
  const seenMs = new Set<number>();

  for (const row of microsoftRows) {
    const kd = Number(row.knowledge_document_id);
    if (!Number.isFinite(kd) || seenMs.has(kd)) continue;
    seenMs.add(kd);

    if (row.source_type === "onedrive") {
      counts.set("onedrive", (counts.get("onedrive") ?? 0) + 1);
    } else if (row.source_type === "sharepoint") {
      counts.set("sharepoint", (counts.get("sharepoint") ?? 0) + 1);
    } else if (row.source_type === "outlook_shared") {
      const provenance = parseProvenance(row.provenance_json);
      if (
        isOutlookAttachmentItem({
          externalId: row.external_id,
          externalItemId: row.external_item_id,
          itemKind: typeof provenance.itemKind === "string" ? provenance.itemKind : null,
        })
      ) {
        counts.set("outlook_attachments", (counts.get("outlook_attachments") ?? 0) + 1);
      }
    }
  }

  if (typeof mcpActivity?.googleDriveUniqueCount === "number") {
    counts.set("google_drive", mcpActivity.googleDriveUniqueCount);
  }

  const sourceCounts: DocumentActivitySourceCount[] = (
    ["google_drive", "onedrive", "sharepoint", "outlook_attachments"] as const
  )
    .filter((key) => counts.has(key) || (key !== "google_drive" && microsoftRows.length > 0))
    .filter((key) => key !== "google_drive" || counts.has("google_drive"))
    .map((key) => ({
      key,
      label: documentActivitySourceLabel(key),
      count: counts.get(key) ?? 0,
    }));

  const newDocuments: ClassifiedActivityDocument[] = [];
  const updatedDocuments: ClassifiedActivityDocument[] = [];

  const pushClassified = (
    title: string,
    sourceKey: DocumentActivitySourceKey,
    createdAt: string | null | undefined,
    sourceModifiedAt: string | null | undefined,
  ) => {
    const kind = classifyDocumentActivity({
      createdAt,
      sourceModifiedAt,
      windowStart: window.from,
      windowEnd: window.to,
    });
    if (!kind) return;
    const item: ClassifiedActivityDocument = {
      title: title.trim() || "Untitled document",
      sourceKey,
      sourceLabel: documentActivityLineSourceLabel(sourceKey),
      kind,
    };
    if (kind === "new") newDocuments.push(item);
    else updatedDocuments.push(item);
  };

  for (const row of microsoftRows) {
    let sourceKey: DocumentActivitySourceKey | null = null;
    if (row.source_type === "onedrive") sourceKey = "onedrive";
    else if (row.source_type === "sharepoint") sourceKey = "sharepoint";
    else if (row.source_type === "outlook_shared") {
      const provenance = parseProvenance(row.provenance_json);
      if (
        isOutlookAttachmentItem({
          externalId: row.external_id,
          externalItemId: row.external_item_id,
          itemKind: typeof provenance.itemKind === "string" ? provenance.itemKind : null,
        })
      ) {
        sourceKey = "outlook_attachments";
      }
    }
    if (!sourceKey) continue;
    pushClassified(row.title, sourceKey, row.created_at, row.modified_at);
  }

  for (const doc of mcpActivity?.documents ?? []) {
    if (doc.source !== "google_drive") continue;
    pushClassified(String(doc.title ?? "Untitled document"), "google_drive", doc.createdAt, doc.driveModifiedTime);
  }

  return {
    companyId,
    windowFrom: window.from.toISOString(),
    windowTo: window.to.toISOString(),
    sourceCounts,
    totalCount: sourceCounts.reduce((sum, row) => sum + row.count, 0),
    newDocuments,
    updatedDocuments,
    canDistinguishNewUpdated: true,
    sourcesQueried,
    sourcesUnavailable,
    triggeredProviderScan: false,
  };
}
