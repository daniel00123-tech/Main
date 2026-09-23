/**
 * Production Company Knowledge search helpers for Microsoft acceptance (CMD16C).
 */

import type { Env } from "../env";
import { executeRegisteredMcpTool } from "./control-plane";
import { extractHitList, unwrapToolPayload } from "./mcp-knowledge-standard";

export type KnowledgeSearchHitSummary = {
  title: string | null;
  documentId: string | number | null;
  category: string | null;
  source: string | null;
  snippet: string | null;
  topic: string | null;
};

export function summarizeKnowledgeSearchHits(
  hits: Record<string, unknown>[],
): KnowledgeSearchHitSummary[] {
  return hits.slice(0, 8).map((row) => {
    const provenance =
      row.provenance && typeof row.provenance === "object"
        ? (row.provenance as Record<string, unknown>)
        : {};
    const meta =
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {};
    return {
      title: String(row.title ?? row.documentTitle ?? row.filename ?? "") || null,
      documentId: (row.documentId ?? row.document_id ?? provenance.documentId ?? null) as
        | string
        | number
        | null,
      category: String(row.category ?? provenance.sourceType ?? meta.category ?? "") || null,
      source: String(row.source ?? provenance.connector ?? "") || null,
      snippet: String(row.snippet ?? row.text ?? row.excerpt ?? "").slice(0, 160) || null,
      topic: String(row.topic ?? provenance.topic ?? "") || null,
    };
  });
}

export function knowledgeSearchHitsFromPayload(payload: unknown): Record<string, unknown>[] {
  return extractHitList(unwrapToolPayload(payload));
}

export async function runProductionKnowledgeSearch(
  env: Env,
  input: {
    companyId: string;
    query: string;
    limit?: number;
    actor?: string;
  },
): Promise<{
  ok: boolean;
  path: "direct_mcp";
  query: string;
  hitCount: number;
  hits: KnowledgeSearchHitSummary[];
  outlookHitCount: number;
  error?: string;
  status?: number;
}> {
  const mcp = await env.DB.prepare(
    `SELECT id FROM mcp_environments WHERE company_id = ? LIMIT 1`,
  )
    .bind(input.companyId)
    .first<{ id: string }>();
  if (!mcp?.id) {
    return {
      ok: false,
      path: "direct_mcp",
      query: input.query,
      hitCount: 0,
      hits: [],
      outlookHitCount: 0,
      error: "No MCP environment for company",
    };
  }

  const actor = input.actor ?? "cmd16c-acceptance";
  const result = await executeRegisteredMcpTool(env, {
    mcpId: mcp.id,
    toolName: "search_company_knowledge",
    arguments: { query: input.query, limit: input.limit ?? 5 },
    actorUserId: actor,
    actorEmail: `${actor}@system`,
    sourceClient: actor,
    skipUsageRecording: true,
  });

  if (result.status !== 200) {
    return {
      ok: false,
      path: "direct_mcp",
      query: input.query,
      hitCount: 0,
      hits: [],
      outlookHitCount: 0,
      error: "error" in result ? String(result.error) : "MCP search failed",
      status: result.status,
    };
  }

  const payload = (result.data as Record<string, unknown>).result;
  const rawHits = knowledgeSearchHitsFromPayload(payload);
  const hits = summarizeKnowledgeSearchHits(rawHits);
  const outlookHitCount = rawHits.filter((row) => {
    const category = String(row.category ?? "");
    const source = String(row.source ?? "");
    const topic = String(row.topic ?? "");
    return (
      category === "outlook_shared" ||
      (source === "microsoft_365" && topic.toLowerCase().includes("outlook"))
    );
  }).length;

  return {
    ok: true,
    path: "direct_mcp",
    query: input.query,
    hitCount: rawHits.length,
    hits,
    outlookHitCount,
  };
}

export async function runGatewayKnowledgeSearch(
  env: Env,
  input: { companyId: string; query: string; limit?: number },
): Promise<{
  ok: boolean;
  path: "gateway_self_fetch";
  query: string;
  hitCount: number;
  hits: KnowledgeSearchHitSummary[];
  outlookHitCount: number;
  httpStatus: number;
  error?: string;
  jsonRpcError?: unknown;
}> {
  const { newId, nowIso } = await import("../db/mappers");
  const { createHash, randomBytes } = await import("node:crypto");
  const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
  const svcId = newId("svc");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const scopes = JSON.stringify(["knowledge.search", "knowledge.read", "system.health"]);
  const mcp = await env.DB.prepare(
    `SELECT id FROM mcp_environments WHERE company_id = ? LIMIT 1`,
  )
    .bind(input.companyId)
    .first<{ id: string }>();
  if (!mcp?.id) {
    return {
      ok: false,
      path: "gateway_self_fetch",
      query: input.query,
      hitCount: 0,
      hits: [],
      outlookHitCount: 0,
      httpStatus: 0,
      error: "No MCP environment for company",
    };
  }

  await env.DB.prepare(
    `INSERT INTO service_identities (
      id, company_id, name, description, status, secret_ref, identity_type,
      token_hash, token_prefix, last_used_at, request_count, scopes_json,
      mcp_environment_id, created_at, updated_at
    ) VALUES (?, ?, 'CMD16C gateway probe', 'acceptance cleanup', 'active', NULL, 'chatgpt',
      ?, ?, NULL, 0, ?, ?, ?, ?)`,
  )
    .bind(svcId, input.companyId, tokenHash, token.slice(0, 12), scopes, mcp.id, nowIso(), nowIso())
    .run();

  const base = (env.INFRA_PUBLIC_API_URL ?? "https://api.infrastack.app").replace(
    /\/$/,
    "",
  );

  await fetch(`${base}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    }),
  });

  const res = await fetch(`${base}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "search_company_knowledge",
        arguments: { query: input.query, limit: input.limit ?? 5 },
      },
    }),
  });

  await env.DB.prepare(`DELETE FROM service_identities WHERE id = ?`).bind(svcId).run();

  const body = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
  };

  if (!res.ok || body.error) {
    return {
      ok: false,
      path: "gateway_self_fetch",
      query: input.query,
      hitCount: 0,
      hits: [],
      outlookHitCount: 0,
      httpStatus: res.status,
      error: "Gateway search request failed",
      jsonRpcError: body.error ?? null,
    };
  }

  const text = body.result?.content?.find((p) => p.type === "text")?.text;
  let payload: unknown = body.result?.structuredContent ?? null;
  if (!payload && text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  const rawHits = knowledgeSearchHitsFromPayload(payload);
  const hits = summarizeKnowledgeSearchHits(rawHits);
  const outlookHitCount = rawHits.filter((row) => String(row.category ?? "") === "outlook_shared").length;

  return {
    ok: true,
    path: "gateway_self_fetch",
    query: input.query,
    hitCount: rawHits.length,
    hits,
    outlookHitCount,
    httpStatus: res.status,
  };
}

export function findOutlookSearchHit(
  hits: KnowledgeSearchHitSummary[],
  expected: { title?: string; documentId?: number | null; filenameFragment?: string },
): KnowledgeSearchHitSummary | null {
  return (
    hits.find((hit) => {
      if (expected.documentId != null && hit.documentId === expected.documentId) return true;
      if (expected.title && hit.title === expected.title) return true;
      if (
        expected.filenameFragment &&
        (hit.title?.includes(expected.filenameFragment) ||
          hit.topic?.includes(expected.filenameFragment))
      ) {
        return true;
      }
      return false;
    }) ?? null
  );
}
