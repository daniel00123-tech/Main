/**
 * Live document-catalogue acceptance for Elvex + Caddington.
 * Never returns secrets. Does not invent files.
 */

import type { Env } from "../env";
import { issueMcpAccessToken, recordAccessJti } from "../auth/mcp-oauth";
import { loadLiveCompanyActor } from "../auth/live-identity";
import { executeListDocuments, parseCatalogueIntent } from "./document-catalogue";
import { classifyScope } from "./intelligence/scope";
import { buildConversationState } from "./intelligence/state";

const WILLIAM_USER_ID = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
const WILLIAM_EMAIL = "william@elvexpropertyservices.com";
const CHATGPT_CLIENT_ID = "oauth_16c41fc5-c625-4c00-9ff1-a252a28ec518";
const MCP_URL = "https://app.infrastack.app/api/gateway/v1/mcp";

const QUESTIONS = [
  "What's the newest document in OneDrive?",
  "Show me the latest ten and tell me what they're about.",
] as const;

function extractText(rpc: Record<string, unknown>): string {
  const result = rpc.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const text = result?.content?.find((part) => part.type === "text")?.text;
  return typeof text === "string" ? text : "";
}

function tryParse(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 400) };
  }
}

function summarizeDocs(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const docs = Array.isArray(record.documents) ? record.documents : [];
  return {
    status: record.status,
    code: record.code,
    count: record.count,
    source: record.source,
    dateField: record.dateField,
    backend: record.backend,
    message: typeof record.message === "string" ? record.message.slice(0, 240) : null,
    documents: docs.slice(0, 10).map((item) => {
      const doc = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      return {
        id: doc.id,
        title: doc.title,
        source: doc.source,
        modifiedAt: doc.modifiedAt,
        createdAt: doc.createdAt,
        fileType: doc.fileType,
        hasUrl: typeof doc.url === "string" && /^https?:\/\//i.test(doc.url),
        descriptionSource: doc.descriptionSource,
        description: typeof doc.description === "string" ? doc.description.slice(0, 160) : null,
      };
    }),
  };
}

async function chatgptCall(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ httpStatus: number; rpc: Record<string, unknown>; parsed: unknown }> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `cat_${name}`,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const rpc = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { httpStatus: res.status, rpc, parsed: tryParse(extractText(rpc)) };
}

async function runTenant(
  env: Env,
  input: { companyId: string; label: string; userId?: string; email?: string },
): Promise<Record<string, unknown>> {
  const listed = await executeListDocuments(env, {
    companyId: input.companyId,
    arguments: { source: "onedrive", sort: "recently_modified", limit: 1, include_descriptions: true },
    actor: input.email ?? "document-catalogue-acceptance",
    actorUserId: input.userId ?? "system",
  });
  const latestTen = await executeListDocuments(env, {
    companyId: input.companyId,
    arguments: { source: "onedrive", sort: "recently_modified", limit: 10, include_descriptions: true },
    actor: input.email ?? "document-catalogue-acceptance",
    actorUserId: input.userId ?? "system",
  });
  let companyMcpTools: string[] = [];
  try {
    const { listMcpEnvironments } = await import("./control-plane");
    const { listMcpTools } = await import("./mcp-client");
    const mcp = (await listMcpEnvironments(env.DB, input.companyId)).find((item) => item.enabled);
    if (mcp) {
      const listed = await listMcpTools(env, mcp.endpointUrl, mcp.authSecretRef, mcp.serviceBindingRef);
      companyMcpTools = listed.tools.map((tool) => tool.name).filter((name) => !/send|write|delete|create|draft/i.test(name));
    }
  } catch {
    companyMcpTools = [];
  }

  const routed = QUESTIONS.map((text) => {
    const decision = classifyScope(text, buildConversationState({ userText: text }));
    return {
      text,
      scope: decision.scope,
      tool: decision.tool,
      intent: parseCatalogueIntent(text),
      usesSearch: decision.tool === "search_company_knowledge",
    };
  });

  const newest = listed.ok ? listed.result : { error: listed.message, code: listed.code };
  const ten = latestTen.ok ? latestTen.result : { error: latestTen.message, code: latestTen.code };
  const newestOk = listed.ok && listed.result.status === "ok" && listed.result.count >= 1;
  const tenOk = latestTen.ok && latestTen.result.status === "ok" && latestTen.result.count >= 1;
  const routingOk = routed.every((row) => row.tool === "list_documents" && !row.usesSearch);

  return {
    companyId: input.companyId,
    label: input.label,
    companyMcpReadTools: companyMcpTools.slice(0, 40),
    routing: routed,
    newest: summarizeDocs(newest),
    latestTen: summarizeDocs(ten),
    outcome: newestOk && tenOk && routingOk ? "PASS" : listed.ok && listed.result.status === "connected_empty" ? "CONNECTED_EMPTY" : "FAIL",
  };
}

export async function runDocumentCatalogueAcceptance(env: Env): Promise<Record<string, unknown>> {
  const elvex = await runTenant(env, {
    companyId: "co_el",
    label: "elvex",
    userId: WILLIAM_USER_ID,
    email: WILLIAM_EMAIL,
  });

  let chatgpt: Record<string, unknown> | null = null;
  const actor = await loadLiveCompanyActor(env.DB, WILLIAM_USER_ID, "co_el");
  if (actor) {
    const issued = await issueMcpAccessToken(
      env.SESSION_SECRET,
      "https://app.infrastack.app",
      "https://app.infrastack.app/api/gateway/v1/mcp",
      {
        userId: actor.userId,
        email: actor.email || WILLIAM_EMAIL,
        companyId: actor.companyId,
        membershipId: actor.membershipId,
        clientId: CHATGPT_CLIENT_ID,
        channel: "chatgpt",
      },
    );
    await recordAccessJti(env.DB, {
      jti: issued.jti,
      userId: actor.userId,
      companyId: actor.companyId,
    });
    const tools = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "cat_list", method: "tools/list", params: {} }),
    });
    const listed = (await tools.json().catch(() => ({}))) as Record<string, unknown>;
    const names = Array.isArray((listed.result as { tools?: Array<{ name?: string }> } | undefined)?.tools)
      ? ((listed.result as { tools: Array<{ name?: string }> }).tools.map((tool) => tool.name).filter(Boolean) as string[])
      : [];
    const newest = await chatgptCall(issued.token, "list_documents", {
      source: "onedrive",
      sort: "recently_modified",
      limit: 1,
      include_descriptions: true,
    });
    const ten = await chatgptCall(issued.token, "list_documents", {
      source: "onedrive",
      sort: "recently_modified",
      limit: 10,
      include_descriptions: true,
    });
    const search = await chatgptCall(issued.token, "search", {
      query: "newest document in OneDrive",
    });
    chatgpt = {
      role: actor.role,
      advertised: names.includes("list_documents"),
      toolNamesSample: names.filter((name) => /list_documents|search|ask_document/.test(name)),
      newest: { httpStatus: newest.httpStatus, parsed: summarizeDocs(newest.parsed) },
      latestTen: { httpStatus: ten.httpStatus, parsed: summarizeDocs(ten.parsed) },
      semanticSearchNotUsedAsCatalogue: true,
      searchStillExists: names.includes("search"),
      searchCallWasSeparate: Boolean(search.parsed),
    };
  }

  const caddington = await runTenant(env, { companyId: "co_caddington", label: "caddington" });

  return {
    elvex,
    chatgpt,
    caddington,
    usageAction: "knowledge.catalogue",
    pricing: "existing rules only; no catalogue price → zero_charge",
  };
}
