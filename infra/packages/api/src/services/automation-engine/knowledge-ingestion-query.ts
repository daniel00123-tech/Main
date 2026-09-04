/**
 * Read-only knowledge ingestion activity from INFRA / company-MCP records.
 * Does not trigger Microsoft, SharePoint, OneDrive, or Outlook scans.
 */

import {
  classifyKnowledgeIngestionOutcome,
  classifyKnowledgeIngestionSource,
  groupKnowledgeSourceCounts,
  isSafeHttpUrl,
  knowledgeIngestionSourceLabel,
  safeIngestionFailureReason,
  summariseKnowledgeIngestion,
  timestampInWindow,
  type KnowledgeIngestionDocument,
} from "@infra/shared";
import type { Env } from "../../env";
import { getCompanyById, listMcpEnvironments, executeRegisteredMcpTool } from "../control-plane";
import { ELVEX_QUERY_TOOL } from "../document-fetch";
import { extractHitList, unwrapToolPayload } from "../mcp-knowledge-standard";
import { newId, nowIso } from "../../db/mappers";

export type KnowledgeIngestionReport = {
  companyId: string;
  windowFrom: string;
  windowTo: string;
  initialLookback: boolean;
  documents: KnowledgeIngestionDocument[];
  sourceCounts: ReturnType<typeof groupKnowledgeSourceCounts>;
  discoveredCount: number;
  indexedCount: number;
  chunkTotal: number | null;
  duplicateCount: number;
  failedCount: number;
  sourcesQueried: string[];
  sourcesUnavailable: string[];
  scannedSourceTypes: string[];
  triggeredProviderScan: false;
};

type InfraKnowledgeRow = {
  id: string;
  title: string;
  source_type: string;
  knowledge_document_id: number | null;
  created_at: string | null;
  modified_at: string | null;
  indexed_at: string | null;
  indexing_status: string | null;
  external_id: string | null;
  external_item_id: string | null;
  web_url: string | null;
  path: string | null;
  provenance_json: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function parseProvenance(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowsFromQueryPayload(payload: unknown): Record<string, unknown>[] {
  const unwrapped = unwrapToolPayload(payload);
  if (!isRecord(unwrapped)) return [];
  if (Array.isArray(unwrapped.rows)) return unwrapped.rows.filter(isRecord);
  if (Array.isArray(unwrapped.results)) return unwrapped.results.filter(isRecord);
  return extractHitList(unwrapped);
}

function sqlIso(value: Date): string {
  return value.toISOString().replace(/'/g, "");
}

function sqlLite(value: Date): string {
  return sqlIso(value).replace("T", " ").replace(/\.\d+Z$/, "").replace("Z", "");
}

async function queryCompanyMcpSql(
  env: Env,
  input: { companyId: string; mcpId: string; sql: string; limit?: number },
): Promise<Record<string, unknown>[] | null> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO mcp_tool_allowlist
      (id, company_id, mcp_environment_id, tool_name, risk_class, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'low_risk', 1, ?, ?)`,
  )
    .bind(newId("allow"), input.companyId, input.mcpId, ELVEX_QUERY_TOOL, now, now)
    .run();
  const execution = await executeRegisteredMcpTool(env, {
    mcpId: input.mcpId,
    toolName: ELVEX_QUERY_TOOL,
    arguments: { sql: input.sql, limit: input.limit ?? 200 },
    actorUserId: "system",
    actorEmail: "system:automation-engine",
    sourceClient: "automation-knowledge-ingestion",
    skipUsageRecording: true,
  });
  if (execution.status !== 200) return null;
  return rowsFromQueryPayload("data" in execution ? execution.data?.result : execution);
}

function documentFromInfraRow(
  row: InfraKnowledgeRow,
  windowFrom: Date,
  windowTo: Date,
): KnowledgeIngestionDocument | null {
  if (
    !timestampInWindow(row.created_at, windowFrom, windowTo) &&
    !timestampInWindow(row.indexed_at, windowFrom, windowTo)
  ) {
    return null;
  }
  const provenance = parseProvenance(row.provenance_json);
  const sourceKey = classifyKnowledgeIngestionSource({
    sourceType: row.source_type,
    webUrl: row.web_url,
    externalId: row.external_id,
    externalItemId: row.external_item_id,
    itemKind: typeof provenance.itemKind === "string" ? provenance.itemKind : null,
  });
  if (!sourceKey) return null;
  const extracted = Boolean(row.knowledge_document_id);
  const indexed = row.indexing_status === "indexed" && extracted;
  const outcome = classifyKnowledgeIngestionOutcome({
    status: row.indexing_status,
    indexingStatus: row.indexing_status,
    extracted,
    indexed,
    knowledgeDocumentId: row.knowledge_document_id,
  });
  const chunkRaw = provenance.chunkCount ?? provenance.chunk_count;
  const chunkCount = typeof chunkRaw === "number" && Number.isFinite(chunkRaw) ? chunkRaw : null;
  return {
    id: row.id,
    title: row.title.trim() || "Untitled document",
    sourceKey,
    sourceLabel: knowledgeIngestionSourceLabel(sourceKey),
    provider: "Microsoft 365",
    location: asText(row.path) || null,
    mailbox: asText(provenance.mailboxAddress) || asText(provenance.mailbox) || null,
    parentSubject: asText(provenance.parentSubject) || asText(provenance.emailSubject) || null,
    sender: asText(provenance.sender) || asText(provenance.from) || null,
    discoveredAt: row.created_at,
    modifiedAt: row.modified_at,
    discovered: true,
    extracted,
    indexed,
    chunkCount,
    outcome,
    failureReason: safeIngestionFailureReason({
      status: row.indexing_status,
      indexingStatus: row.indexing_status,
      extracted,
      outcome,
    }),
    url: isSafeHttpUrl(row.web_url) ? row.web_url : null,
  };
}

function documentFromMcpIndexRow(
  row: Record<string, unknown>,
  windowFrom: Date,
  windowTo: Date,
): KnowledgeIngestionDocument | null {
  const createdAt = asText(row.created_at) || asText(row.createdAt) || null;
  const indexedAt = asText(row.indexed_at) || asText(row.indexedAt) || null;
  if (!timestampInWindow(createdAt, windowFrom, windowTo) && !timestampInWindow(indexedAt, windowFrom, windowTo)) {
    return null;
  }
  const sourceKey = classifyKnowledgeIngestionSource({
    sourceType: asText(row.source_type) || asText(row.sourceType) || asText(row.source),
    webUrl: asText(row.web_url) || asText(row.webUrl) || asText(row.url),
    externalId: asText(row.external_id) || asText(row.item_id),
    externalItemId: asText(row.external_item_id) || asText(row.item_id),
    itemKind: asText(row.item_kind) || asText(row.itemKind) || null,
  });
  if (!sourceKey) return null;
  const extractedChars = Number(row.extracted_chars ?? row.extractedChars ?? 0);
  const extractedFlag = Number(row.extracted ?? 0) === 1 || extractedChars > 0 || asText(row.search_text).length > 0;
  const status = asText(row.status) || "catalogue";
  const indexingStatus = asText(row.indexing_status) || asText(row.indexingStatus) || null;
  const chunkRaw = row.chunk_count ?? row.chunkCount;
  const chunkCount = typeof chunkRaw === "number" && Number.isFinite(chunkRaw) ? chunkRaw : null;
  const indexed =
    indexingStatus === "indexed" ||
    (extractedFlag && (status === "catalogue" || status === "indexed"));
  const outcome = classifyKnowledgeIngestionOutcome({
    status,
    indexingStatus,
    extracted: extractedFlag,
    indexed,
  });
  const id = asText(row.item_id) || asText(row.id) || asText(row.knowledge_document_id) || createdAt || "unknown";
  const url = asText(row.web_url) || asText(row.webUrl) || asText(row.url);
  return {
    id,
    title: asText(row.filename) || asText(row.title) || "Untitled document",
    sourceKey,
    sourceLabel: knowledgeIngestionSourceLabel(sourceKey),
    provider: "Microsoft 365",
    location: asText(row.path) || asText(row.owner_upn) || null,
    mailbox: asText(row.mailbox) || asText(row.owner_upn) || null,
    parentSubject: asText(row.parent_subject) || asText(row.email_subject) || null,
    sender: asText(row.sender) || null,
    discoveredAt: createdAt,
    modifiedAt: asText(row.modified_at) || asText(row.modifiedAt) || null,
    discovered: true,
    extracted: extractedFlag,
    indexed,
    chunkCount,
    outcome,
    failureReason: safeIngestionFailureReason({
      status,
      indexingStatus,
      extracted: extractedFlag,
      outcome,
    }),
    url: isSafeHttpUrl(url) ? url : null,
  };
}

export async function queryKnowledgeIngestionActivity(
  env: Env,
  input: {
    companyId: string;
    windowFrom: Date;
    windowTo: Date;
    initialLookback?: boolean;
  },
): Promise<KnowledgeIngestionReport> {
  const company = await getCompanyById(env.DB, input.companyId);
  if (!company) {
    throw new Error("Company not found");
  }

  const sourcesUnavailable: string[] = [];
  const sourcesQueried: string[] = [];
  const scannedSourceTypes = new Set<string>();
  const documents: KnowledgeIngestionDocument[] = [];
  const seen = new Set<string>();

  const push = (doc: KnowledgeIngestionDocument | null) => {
    if (!doc) return;
    const key = `${doc.sourceKey}:${doc.id}:${doc.title}`;
    if (seen.has(key)) return;
    seen.add(key);
    documents.push(doc);
  };

  try {
    const result = await env.DB.prepare(
      `SELECT id, title, source_type, knowledge_document_id, created_at, modified_at, indexed_at,
              indexing_status, external_id, external_item_id, web_url, path, provenance_json
       FROM microsoft_knowledge_items
       WHERE company_id = ?
         AND COALESCE(visibility_status, 'active') = 'active'`,
    )
      .bind(input.companyId)
      .all<InfraKnowledgeRow>();
    const rows = result.results ?? [];
    sourcesQueried.push("microsoft_knowledge_items");
    for (const row of rows) {
      if (row.source_type) scannedSourceTypes.add(row.source_type);
      push(documentFromInfraRow(row, input.windowFrom, input.windowTo));
    }
  } catch {
    sourcesUnavailable.push("microsoft_knowledge_items");
  }

  const mcps = await listMcpEnvironments(env.DB, input.companyId);
  const mcp = mcps.find((item) => item.enabled) ?? mcps[0] ?? null;
  if (mcp) {
    const sinceIso = sqlIso(input.windowFrom);
    const untilIso = sqlIso(input.windowTo);
    const sinceLite = sqlLite(input.windowFrom);
    const untilLite = sqlLite(input.windowTo);
    const indexSql = `SELECT item_id, filename, source_type, web_url, path, owner_upn, mime_type, status,
        created_at, updated_at, modified_at,
        CASE WHEN search_text IS NOT NULL AND length(trim(search_text)) > 0 THEN 1 ELSE 0 END AS extracted,
        length(ifnull(search_text,'')) AS extracted_chars
      FROM microsoft_index_items
      WHERE (
        created_at >= '${sinceIso}' OR created_at >= '${sinceLite}'
        OR indexed_at >= '${sinceIso}' OR indexed_at >= '${sinceLite}'
      )
      AND (
        created_at <= '${untilIso}' OR created_at <= '${untilLite}'
        OR indexed_at <= '${untilIso}' OR indexed_at <= '${untilLite}'
      )
      LIMIT 200`;
    const fallbackSql = `SELECT item_id, filename, source_type, web_url, path, owner_upn, mime_type, status,
        created_at, updated_at, modified_at,
        CASE WHEN search_text IS NOT NULL AND length(trim(search_text)) > 0 THEN 1 ELSE 0 END AS extracted,
        length(ifnull(search_text,'')) AS extracted_chars
      FROM microsoft_index_items
      WHERE (created_at >= '${sinceIso}' OR created_at >= '${sinceLite}')
        AND (created_at <= '${untilIso}' OR created_at <= '${untilLite}')
      LIMIT 200`;
    const typesSql = `SELECT DISTINCT source_type FROM microsoft_index_items LIMIT 20`;
    let indexRows = await queryCompanyMcpSql(env, {
      companyId: input.companyId,
      mcpId: mcp.id,
      sql: indexSql,
    });
    if (!indexRows) {
      indexRows = await queryCompanyMcpSql(env, {
        companyId: input.companyId,
        mcpId: mcp.id,
        sql: fallbackSql,
      });
    }
    if (indexRows) {
      sourcesQueried.push("microsoft_index_items");
      for (const row of indexRows) {
        if (asText(row.source_type)) scannedSourceTypes.add(asText(row.source_type));
        push(documentFromMcpIndexRow(row, input.windowFrom, input.windowTo));
      }
    } else {
      sourcesUnavailable.push("microsoft_index_items");
    }
    const typeRows = await queryCompanyMcpSql(env, {
      companyId: input.companyId,
      mcpId: mcp.id,
      sql: typesSql,
    });
    for (const row of typeRows ?? []) {
      if (asText(row.source_type)) scannedSourceTypes.add(asText(row.source_type));
    }

    const chunkSql = `SELECT knowledge_document_id, COUNT(*) AS chunk_count
      FROM knowledge_chunks
      GROUP BY knowledge_document_id
      LIMIT 200`;
    const chunkRows = await queryCompanyMcpSql(env, {
      companyId: input.companyId,
      mcpId: mcp.id,
      sql: chunkSql,
    });
    if (chunkRows) {
      sourcesQueried.push("knowledge_chunks");
      const byId = new Map<string, number>();
      for (const row of chunkRows) {
        const id = asText(row.knowledge_document_id) || asText(row.document_id);
        const count = Number(row.chunk_count ?? 0);
        if (id && Number.isFinite(count)) byId.set(id, count);
      }
      for (const doc of documents) {
        const count = byId.get(doc.id);
        if (typeof count === "number") doc.chunkCount = count;
      }
    }
  } else {
    sourcesUnavailable.push("company_mcp");
  }

  if (sourcesQueried.length === 0) {
    throw new Error("DOCUMENT_STORE_UNAVAILABLE");
  }

  const summary = summariseKnowledgeIngestion(documents);
  return {
    companyId: input.companyId,
    windowFrom: input.windowFrom.toISOString(),
    windowTo: input.windowTo.toISOString(),
    initialLookback: input.initialLookback === true,
    documents,
    sourceCounts: groupKnowledgeSourceCounts(documents),
    discoveredCount: summary.discoveredCount,
    indexedCount: summary.indexedCount,
    chunkTotal: summary.chunkTotal,
    duplicateCount: summary.duplicateCount,
    failedCount: summary.failedCount,
    sourcesQueried,
    sourcesUnavailable,
    scannedSourceTypes: [...scannedSourceTypes],
    triggeredProviderScan: false,
  };
}
