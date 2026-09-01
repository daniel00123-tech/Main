/**
 * Tenant-agnostic document Q&A acceptance (Elvex + Caddington).
 * Runs inside the worker against company MCP + ask_document.
 * Never returns secrets. Does not search globally after a document is selected.
 */

import type { Env } from "../env";
import { executeAskDocument } from "./ask-document";
import { executeRegisteredMcpTool, listMcpEnvironments } from "./control-plane";
import { toStandardSearchPayload } from "./mcp-knowledge-standard";

const TENANTS = [
  { companyId: "co_el", label: "elvex" },
  { companyId: "co_caddington", label: "caddington" },
] as const;

export async function runKnowledgeQaAcceptance(
  env: Env,
  companyId?: string,
): Promise<Record<string, unknown>> {
  const targets = companyId
    ? TENANTS.filter((tenant) => tenant.companyId === companyId)
    : [...TENANTS];
  const tenants: Record<string, unknown>[] = [];
  for (const tenant of targets) {
    tenants.push(await runOneTenant(env, tenant.companyId, tenant.label));
  }
  return { tenants };
}

async function runOneTenant(
  env: Env,
  companyId: string,
  label: string,
): Promise<Record<string, unknown>> {
  const mcp = (await listMcpEnvironments(env.DB, companyId)).find((item) => item.enabled);
  if (!mcp) {
    return { companyId, label, outcome: "UPSTREAM_FAILURE", reason: "no enabled company MCP" };
  }
  const search = await executeRegisteredMcpTool(env, {
    mcpId: mcp.id,
    toolName: "search_company_knowledge",
    arguments: { query: "company policy" },
    actorUserId: "system",
    actorEmail: "knowledge-qa-acceptance",
    sourceClient: "infra-ask-document",
    skipUsageRecording: true,
  });
  const hits = toStandardSearchPayload("data" in search ? search.data?.result : search).results;
  let first = hits[0];
  let qa: Awaited<ReturnType<typeof executeAskDocument>> | null = null;
  let factual = "";
  for (const hit of hits.slice(0, 5)) {
    if (!hit.id) continue;
    factual = `What is the main purpose of ${hit.title}?`;
    const candidate = await executeAskDocument(env, {
      companyId,
      arguments: { documentId: hit.id, question: factual, title: hit.title },
      actor: "knowledge-qa-acceptance",
      actorUserId: "system",
    });
    const chunks = candidate.ok ? Number(candidate.diagnostics.chunkCount ?? 0) : 0;
    if (candidate.ok && chunks > 0) {
      first = hit;
      qa = candidate;
      break;
    }
    if (!qa) {
      first = hit;
      qa = candidate;
    }
  }
  if (!first?.id || !qa) {
    return { companyId, label, outcome: "NO_RESULTS", reason: "search returned no document id", hitCount: hits.length };
  }
  const follow = await executeAskDocument(env, {
    companyId,
    arguments: { documentId: first.id, question: "what exactly?", priorQuestion: factual, title: first.title },
    actor: "knowledge-qa-acceptance",
    actorUserId: "system",
  });
  const when = await executeAskDocument(env, {
    companyId,
    arguments: { documentId: first.id, question: "when?", priorQuestion: factual, title: first.title },
    actor: "knowledge-qa-acceptance",
    actorUserId: "system",
  });
  const more = await executeAskDocument(env, {
    companyId,
    arguments: { documentId: first.id, question: "more detail", priorQuestion: factual, title: first.title },
    actor: "knowledge-qa-acceptance",
    actorUserId: "system",
  });
  const unrelated = await executeAskDocument(env, {
    companyId,
    arguments: {
      documentId: first.id,
      question: "does it mention offshore drilling licenses?",
      priorQuestion: factual,
      title: first.title,
    },
    actor: "knowledge-qa-acceptance",
    actorUserId: "system",
  });
  const second = hits.find((hit) => hit.id !== first.id);
  const switched = second
    ? await executeAskDocument(env, {
        companyId,
        arguments: { documentId: second.id, question: "What does this document cover?" },
        actor: "knowledge-qa-acceptance",
        actorUserId: "system",
      })
    : null;

  return {
    companyId,
    label,
    searchQuality: hits.length,
    documentId: first.id,
    title: first.title,
    fetchBackend: qa.ok ? qa.diagnostics.fetchBackend : null,
    chunkCount: qa.ok ? qa.diagnostics.chunkCount : 0,
    factual: summariseAsk(qa),
    whatExactly: summariseAsk(follow),
    when: summariseAsk(when),
    moreDetail: summariseAsk(more),
    unrelated: summariseAsk(unrelated),
    switched: switched ? { documentId: second?.id, ...summariseAsk(switched) } : null,
    autoGlobalFallback: false,
  };
}

function summariseAsk(
  result:
    | { ok: true; result: Record<string, unknown>; diagnostics: Record<string, unknown> }
    | { ok: false; status: number; code: string; message: string },
): Record<string, unknown> {
  if (!result.ok) {
    return { outcome: "UPSTREAM_FAILURE", code: result.code, message: result.message };
  }
  const none = result.result.noneInDocument === true;
  return {
    outcome: none ? "NO_EVIDENCE" : "WORKS",
    confidence: result.result.confidence,
    answerPreview: String(result.result.answer ?? "").slice(0, 220),
    chunkCount: result.diagnostics.chunkCount,
    enriched: result.diagnostics.enriched,
    usedChunkIds: result.diagnostics.usedChunkIds,
  };
}
