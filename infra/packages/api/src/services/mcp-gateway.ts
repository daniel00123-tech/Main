/**
 * INFRA MCP protocol facade (Streamable HTTP).
 *
 * ChatGPT / Claude must connect HERE (not to company MCP directly)
 * so every tools/call is authenticated, authorised, metered, and ledgered.
 *
 * Clients send Accept: application/json, text/event-stream. Prefer JSON for
 * initialize / tools/list / errors — OpenAI ChatGPT clients have been observed
 * to treat SSE-framed tools/list payloads as an empty tool catalogue.
 */

import type { Env } from "../env";
import { listMcpTools } from "./mcp-client";
import {
  executeGatewayRequest,
  resolveGatewayActor,
  type GatewayActor,
} from "./gateway";
import {
  ensureDefaultToolAllowlist,
  getCompanyBySlug,
  getMcpEnvironment,
  listMcpEnvironments,
  recordAuditEvent,
} from "./control-plane";
import {
  evaluateServiceActionPermission,
  serviceHasActionScope,
} from "./service-identities";
import { newId, nowIso } from "../db/mappers";
import { publicToolErrorMessage } from "./public-errors";
import {
  mapFetchArgumentsForCompanyMcp,
  sanitizeStandardFetchArguments,
  sanitizeStandardSearchArguments,
  toStandardFetchPayload,
  toStandardSearchPayload,
  withStandardKnowledgeTools,
  wrapStandardToolResult,
} from "./mcp-knowledge-standard";
import { isXeroWriteToolName } from "./xero-tools";
import { XERO_TOOL_CONTRACTS } from "@infra/shared";
import { withActionControlTools, isActionControlTool, actionControlToolAllowed } from "./mcp-action-tools";
import { withOutlookReadTools, isOutlookReadTool, outlookReadToolAllowed } from "./microsoft-outlook-tools";
import { executeOutlookReadTool } from "./microsoft-outlook-read";
import { executeActionControlTool } from "./action-engine/action-control-handler";
import { applyKnowledgeSourceScopeToSearchArgs } from "./knowledge-source-scope";

type JsonRpcId = string | number | null;

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
) {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

/** Exported for unit tests — content negotiation for Streamable HTTP. */
export function wantsSse(request: Request): boolean {
  const accept = (request.headers.get("Accept") ?? "").toLowerCase();
  // Prefer JSON whenever the client advertises it (ChatGPT sends both).
  if (accept.includes("application/json")) return false;
  if (accept.includes("text/event-stream")) return true;
  return false;
}

function mcpResponse(
  request: Request,
  payload: unknown,
  init?: { status?: number; sessionId?: string | null; wwwAuthenticate?: string },
): Response {
  const status = init?.status ?? 200;
  const headers = new Headers();
  if (init?.sessionId) {
    headers.set("Mcp-Session-Id", init.sessionId);
  }
  if (init?.wwwAuthenticate) {
    headers.set("WWW-Authenticate", init.wwwAuthenticate);
  }

  // Auth failures must be JSON so ChatGPT can surface the challenge rather than
  // treating an SSE error frame as "no tools".
  if (status === 401 || status === 403 || !wantsSse(request)) {
    headers.set("Content-Type", "application/json");
    return Response.json(payload, { status, headers });
  }

  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  return new Response(body, { status, headers });
}

/** Clear, ChatGPT-oriented descriptions for known company knowledge tools. */
export function enrichMcpToolDescription(
  toolName: string,
  upstreamDescription?: string | null,
): string {
  const defaults: Record<string, string> = {
    search:
      "Search this company's knowledge for policies, processes, and other indexed documents. Use a natural-language query. Returns matching documents with stable ids so you can call fetch. Read-only.",
    fetch:
      "Fetch the full content of a company knowledge document previously returned by search. Pass the document id. Read-only. Use the returned url and metadata for source attribution when present.",
    search_company_knowledge:
      "Search this company's indexed knowledge documents (policies, project docs, spend limits, approvals, etc.). Pass a natural-language query only (for example \"vehicle mileage policy\" or \"Company Van Policy\"). Do NOT set topic/category/department filters unless the user explicitly asks to filter by that metadata — invented filters often return zero results. Returns matching excerpts with source document titles.",
    get_knowledge_document:
      "Read a specific company knowledge document by identifier or title after locating it with search_company_knowledge.",
    database_summary:
      "Summarise available company business-data collections exposed through the knowledge layer.",
    system_health:
      "Non-billable health check for the company MCP connection through INFRA. Does not search documents and does not debit the wallet.",
    xero_get_organisation:
      "Read this company's connected Xero organisation profile. Read-only. Returns nothing invented if Xero is not connected.",
    xero_list_contacts:
      "Search this company's Xero contacts (customers and suppliers). Read-only. Requires a connected Xero organisation.",
    xero_get_contact:
      "Fetch one Xero contact by id. Read-only.",
    xero_search_invoices:
      "Search this company's Xero invoices, including overdue or unpaid filters. Read-only.",
    xero_get_invoice:
      "Fetch one Xero invoice by id or invoice number (for example INV-XXXXX). Read-only.",
    xero_list_overdue_invoices:
      "List overdue Xero invoices for this company. Read-only.",
    xero_list_payments:
      "List recent Xero payments. Read-only.",
    xero_list_accounts:
      "List the Xero chart of accounts. Read-only.",
    xero_list_bank_transactions:
      "List recent Xero bank transactions. Read-only.",
    xero_profit_and_loss:
      "Return Xero's Profit & Loss report for a date range using GET /Reports/ProfitAndLoss with fromDate/toDate (YYYY-MM-DD). Parsed summary includes revenue, cost of sales, gross profit, operating expenses and net profit. Optional periods/timeframe supports Xero comparative columns. Read-only.",
    xero_balance_sheet:
      "Return a bounded Xero Balance Sheet report. Read-only.",
    xero_aged_receivables:
      "Return aged receivables or payables for debtor/creditor position. Read-only.",
    xero_sales_summary:
      "Summarise qualifying Accounts Receivable (ACCREC) sales for a date range, net of sales credit notes (ACCRECCREDIT). Excludes purchase bills (ACCPAY), purchase credits, voided/deleted documents. Returns currencyCode and reconcilable transactions. Read-only.",
    xero_top_customers:
      "Return top customers by qualifying ACCREC sales revenue for a date range. Purchase-side documents never count as customers. Amounts use currencyCode (e.g. GBP). Read-only.",
    xero_create_draft_invoice:
      "Create a draft invoice in Xero. Financial write — requires scope upgrade, permission, and production write activation.",
    xero_create_credit_note:
      "Create a credit note in Xero. Financial write — uses execution plan when batching.",
    xero_allocate_payment:
      "Allocate a payment to invoices in Xero. Financial write — remittance workflow.",
  };
  const enriched = defaults[toolName];
  if (enriched) return enriched;
  if (upstreamDescription && upstreamDescription.trim()) {
    return upstreamDescription.trim();
  }
  return `Company capability: ${toolName}`;
}

/**
 * ChatGPT reuses JSON-RPC message ids (often `0`) across unrelated tool calls.
 * Never treat that id as an idempotency key — it collapses every search into one
 * cached (and currently body-less) replay that surfaces as `{}`.
 */
export function resolveMcpClientRequestId(
  request: Request,
  body: {
    id?: JsonRpcId;
    params?: Record<string, unknown>;
  },
): string | null {
  const header =
    request.headers.get("X-Infra-Request-Id")?.trim() ||
    request.headers.get("X-Request-Id")?.trim();
  if (header) return header;

  const params = body.params ?? {};
  if (typeof params.requestId === "string" && params.requestId.trim()) {
    return params.requestId.trim();
  }

  const meta =
    params._meta && typeof params._meta === "object"
      ? (params._meta as Record<string, unknown>)
      : {};
  if (typeof meta.clientRequestId === "string" && meta.clientRequestId.trim()) {
    return meta.clientRequestId.trim();
  }
  if (typeof meta["progressToken"] === "string" && meta["progressToken"].trim()) {
    // Not ideal, but unique per ChatGPT tool invocation when present.
    return `prog_${meta["progressToken"].trim()}`;
  }

  return null;
}

/**
 * Optional client-supplied grouping. JSON-RPC `id` is never used.
 * ChatGPT typically sends nothing — INFRA then generates int_… per operation.
 */
export function pickInteractionHints(
  request: Request,
  body: { params?: Record<string, unknown> },
): {
  interactionId: string | null;
  parentRequestId: string | null;
  mcpSessionId: string | null;
} {
  const params = body.params ?? {};
  const meta =
    params._meta && typeof params._meta === "object"
      ? (params._meta as Record<string, unknown>)
      : {};
  const asString = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  return {
    interactionId:
      request.headers.get("X-Infra-Interaction-Id")?.trim() ||
      asString(meta.interactionId) ||
      asString(params.interactionId),
    parentRequestId:
      request.headers.get("X-Infra-Parent-Request-Id")?.trim() ||
      asString(meta.parentRequestId) ||
      asString(params.parentRequestId),
    mcpSessionId:
      request.headers.get("Mcp-Session-Id")?.trim() ||
      request.headers.get("X-Infra-Mcp-Session-Id")?.trim() ||
      null,
  };
}

export async function detectTenantSpoof(
  db: D1Database,
  request: Request,
  body: { params?: Record<string, unknown> },
  identity: { companyId: string; mcpEnvironmentId?: string | null },
): Promise<{
  attemptedCompanyId?: string;
  attemptedSlug?: string;
  attemptedMcpId?: string;
} | null> {
  const params = body.params ?? {};
  const args =
    params.arguments && typeof params.arguments === "object"
      ? (params.arguments as Record<string, unknown>)
      : {};

  const asString = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  const attemptedCompanyId =
    asString(params.companyId) ||
    asString(request.headers.get("X-Infra-Company-Id")) ||
    asString(args.companyId) ||
    asString(args.company_id);

  if (attemptedCompanyId && attemptedCompanyId !== identity.companyId) {
    return { attemptedCompanyId };
  }

  const attemptedSlug =
    asString(params.companySlug) ||
    asString(request.headers.get("X-Infra-Company-Slug")) ||
    asString(args.companySlug) ||
    asString(args.company_slug);

  if (attemptedSlug) {
    const company = await getCompanyBySlug(db, attemptedSlug);
    if (company && company.id !== identity.companyId) {
      return { attemptedSlug, attemptedCompanyId: company.id };
    }
  }

  const attemptedMcpId =
    asString(params.mcpId) ||
    asString(params.mcpEnvironmentId) ||
    asString(request.headers.get("X-Infra-Mcp-Id")) ||
    asString(args.mcpId) ||
    asString(args.mcpEnvironmentId);

  if (attemptedMcpId) {
    const mcp = await getMcpEnvironment(db, attemptedMcpId);
    if (mcp && mcp.companyId !== identity.companyId) {
      return { attemptedMcpId, attemptedCompanyId: mcp.companyId };
    }
    if (
      identity.mcpEnvironmentId &&
      attemptedMcpId !== identity.mcpEnvironmentId &&
      mcp &&
      mcp.companyId !== identity.companyId
    ) {
      return { attemptedMcpId, attemptedCompanyId: mcp.companyId };
    }
  }

  return null;
}

/** Arguments ChatGPT may safely forward to Caddington knowledge search. */
export const KNOWLEDGE_SEARCH_FORWARD_KEYS = [
  "query",
  "topK",
  "includeNeighbourContext",
  "includeFullContent",
  "includeDiagnostics",
  "title",
  "filename",
  "source",
  "category",
] as const;

/**
 * Drop metadata filters ChatGPT invents from the upstream schema (topic,
 * category, department, …). Those filters are valid Caddington fields but
 * inventing `topic: "policy"` routinely yields resultCount=0 for otherwise
 * good queries such as "vehicle policy".
 */
export function sanitizeKnowledgeSearchArguments(
  args: Record<string, unknown>,
): { forwarded: Record<string, unknown>; strippedKeys: string[] } {
  const forwarded: Record<string, unknown> = {};
  const strippedKeys: string[] = [];
  const allow = new Set<string>(KNOWLEDGE_SEARCH_FORWARD_KEYS);

  for (const [key, value] of Object.entries(args)) {
    if (!allow.has(key)) {
      strippedKeys.push(key);
      continue;
    }
    if (value == null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    forwarded[key] = value;
  }

  return { forwarded, strippedKeys };
}

export function narrowKnowledgeSearchInputSchema(
  upstream: Record<string, unknown>,
): Record<string, unknown> {
  const props =
    upstream.properties && typeof upstream.properties === "object"
      ? (upstream.properties as Record<string, unknown>)
      : {};
  const narrowedProps: Record<string, unknown> = {};
  for (const key of KNOWLEDGE_SEARCH_FORWARD_KEYS) {
    if (props[key]) narrowedProps[key] = props[key];
  }
  if (!narrowedProps.query) {
    narrowedProps.query = {
      type: "string",
      minLength: 1,
      description: "Natural language search query.",
    };
  }
  return {
    type: "object",
    properties: narrowedProps,
    required: ["query"],
    additionalProperties: false,
  };
}

async function resolveToolActionForFilter(
  db: D1Database,
  mcpEnvironmentId: string,
  toolName: string,
): Promise<string> {
  const mapped = await db
    .prepare(
      `SELECT action FROM mcp_tool_action_map
       WHERE mcp_environment_id = ? AND tool_name = ?`,
    )
    .bind(mcpEnvironmentId, toolName)
    .first();
  if (mapped?.action) return String(mapped.action);
  const xeroContract = XERO_TOOL_CONTRACTS.find(
    (tool) => tool.mcpToolName === toolName,
  );
  if (xeroContract) return xeroContract.action;
  if (toolName === "search_company_knowledge" || toolName === "search") {
    return "knowledge.search";
  }
  if (
    toolName === "get_knowledge_document" ||
    toolName === "fetch" ||
    toolName === "database_summary"
  ) {
    return "knowledge.read";
  }
  if (toolName === "system_health") return "system.health";
  return `mcp.${toolName}`;
}

async function logFacadeEvent(
  db: D1Database,
  input: {
    companyId: string | null;
    actor: string;
    method: string;
    toolName?: string | null;
    status: string;
    httpStatus: number;
    detail?: Record<string, unknown>;
  },
) {
  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "company.accessed",
    actor: input.actor,
    resourceType: "mcp_facade",
    resourceId: input.toolName ?? input.method,
    detail: {
      stage: "mcp_facade.request",
      method: input.method,
      toolName: input.toolName ?? null,
      status: input.status,
      httpStatus: input.httpStatus,
      ...(input.detail ?? {}),
    },
  });
}

export async function handleInfraMcpJsonRpc(
  env: Env,
  request: Request,
  actor: GatewayActor,
  body: {
    jsonrpc?: string;
    id?: JsonRpcId;
    method?: string;
    params?: Record<string, unknown>;
  },
) {
  const id = body.id ?? null;
  const method = body.method ?? "";
  const actorLabel =
    actor.type === "service" ? actor.identity.name : actor.user.email;
  const companyId = actor.type === "service" ? actor.identity.companyId : null;

  if (!companyId && actor.type === "service") {
    return {
      payload: jsonRpcError(id, -32001, "Service identity missing company"),
      httpStatus: 400,
    };
  }

  const headerCompany = request.headers.get("X-Infra-Company-Id");
  const requestedCompanyId =
    typeof body.params?.companyId === "string"
      ? body.params.companyId
      : headerCompany;
  // Service identities are bound to one company. Never honour a prompt/header
  // company override — tenant routing comes only from the authenticated identity.
  if (actor.type === "service" && companyId) {
    const spoof = await detectTenantSpoof(env.DB, request, body, {
      companyId,
      mcpEnvironmentId: actor.identity.mcpEnvironmentId,
    });
    if (spoof) {
      await logFacadeEvent(env.DB, {
        companyId,
        actor: actorLabel,
        method,
        status: "denied",
        httpStatus: 403,
        detail: {
          reason: "service_tenant_spoof",
          attemptedCompanyId: spoof.attemptedCompanyId,
          attemptedSlug: spoof.attemptedSlug,
          attemptedMcpId: spoof.attemptedMcpId,
        },
      });
      return {
        payload: jsonRpcError(
          id,
          -32003,
          "Service identity does not belong to this company",
        ),
        httpStatus: 403,
      };
    }
  }

  const resolvedCompanyId = companyId ?? requestedCompanyId ?? null;

  if (!resolvedCompanyId) {
    return {
      payload: jsonRpcError(
        id,
        -32602,
        "companyId is required for INFRA MCP gateway",
      ),
      httpStatus: 400,
    };
  }

  if (method === "initialize") {
    const requested =
      typeof body.params?.protocolVersion === "string"
        ? body.params.protocolVersion
        : "2025-03-26";
    // Prefer modern Streamable HTTP versions ChatGPT/Caddington use.
    const protocolVersion = requested.startsWith("2024-")
      ? "2025-03-26"
      : requested;

    await logFacadeEvent(env.DB, {
      companyId: resolvedCompanyId,
      actor: actorLabel,
      method,
      status: "ok",
      httpStatus: 200,
      detail: { protocolVersion },
    });

    return {
      payload: jsonRpcResult(id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: true },
        },
        serverInfo: {
          name: "infra-gateway",
          version: "1.0.0",
          instructions:
            "All tool calls are authorised, metered, and billed by INFRA. Use search then fetch to read this company's knowledge. Both are read-only. Do not call company MCP endpoints directly.",
        },
        instructions:
          "All tool calls are authorised, metered, and billed by INFRA. Use search then fetch to read this company's knowledge. Both are read-only. Do not call company MCP endpoints directly.",
      }),
      httpStatus: 200,
    };
  }

  if (method === "notifications/initialized") {
    // Streamable HTTP: notifications get 202 + empty body (no JSON-RPC result).
    return { payload: null, httpStatus: 202 };
  }

  if (method === "ping") {
    return { payload: jsonRpcResult(id, {}), httpStatus: 200 };
  }

  if (method === "tools/list") {
    const mcps = await listMcpEnvironments(env.DB, resolvedCompanyId);
    const mcp =
      (actor.type === "service" && actor.identity.mcpEnvironmentId
        ? await getMcpEnvironment(env.DB, actor.identity.mcpEnvironmentId)
        : null) ??
      mcps.find((item) => item.enabled) ??
      mcps[0];

    if (!mcp) {
      return {
        payload: jsonRpcError(id, -32004, "No MCP environment for company"),
        httpStatus: 404,
      };
    }

    await ensureDefaultToolAllowlist(env.DB, resolvedCompanyId, mcp.id);

    try {
      const listed = await listMcpTools(
        env,
        mcp.endpointUrl,
        mcp.authSecretRef,
        mcp.serviceBindingRef,
      );

      const allow = await env.DB.prepare(
        `SELECT tool_name FROM mcp_tool_allowlist
         WHERE mcp_environment_id = ? AND enabled = 1`,
      )
        .bind(mcp.id)
        .all();
      const allowed = new Set(
        (allow.results ?? []).map((row) => String(row.tool_name)),
      );

      const tools = [];
      for (const tool of listed.tools) {
        if (isXeroWriteToolName(tool.name)) continue;
        if (allowed.size > 0 && !allowed.has(tool.name)) continue;

        const action = await resolveToolActionForFilter(env.DB, mcp.id, tool.name);
        if (actor.type === "service") {
          if (!serviceHasActionScope(actor.identity, action)) continue;
          const decision = await evaluateServiceActionPermission(
            env.DB,
            actor.identity,
            action,
          );
          if (!decision.allowed) continue;
        }

        const rawSchema =
          tool.inputSchema &&
          typeof tool.inputSchema === "object" &&
          !Array.isArray(tool.inputSchema)
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} };

        const inputSchema =
          tool.name === "search_company_knowledge"
            ? narrowKnowledgeSearchInputSchema(rawSchema)
            : {
                ...rawSchema,
                type:
                  typeof rawSchema.type === "string" ? rawSchema.type : "object",
              };

        tools.push({
          name: tool.name,
          description: enrichMcpToolDescription(tool.name, tool.description),
          inputSchema,
        });
      }

      const identityScopes =
        actor.type === "service" ? actor.identity.scopes : undefined;
      const advertised = withOutlookReadTools(
        withActionControlTools(withStandardKnowledgeTools(tools), identityScopes),
        identityScopes,
      );

      await logFacadeEvent(env.DB, {
        companyId: resolvedCompanyId,
        actor: actorLabel,
        method,
        status: "ok",
        httpStatus: 200,
        detail: {
          toolNames: advertised.map((t) => t.name),
          mcpId: mcp.id,
          serviceIdentityId:
            actor.type === "service" ? actor.identity.id : null,
          tokenPrefix: actor.type === "service" ? actor.identity.tokenPrefix : null,
          scopeCount:
            actor.type === "service" ? actor.identity.scopes.length : null,
          hasActionScopes:
            actor.type === "service"
              ? actor.identity.scopes.some((s) => s.startsWith("xero.action."))
              : null,
          downstreamToolCount: tools.length,
          actionToolCount: advertised.length - tools.length,
          finalToolCount: advertised.length,
        },
      });

      return {
        payload: jsonRpcResult(id, { tools: advertised }),
        httpStatus: 200,
      };
    } catch (err) {
      await logFacadeEvent(env.DB, {
        companyId: resolvedCompanyId,
        actor: actorLabel,
        method,
        status: "error",
        httpStatus: 502,
        detail: {
          error: err instanceof Error ? err.message : "Failed to list tools",
        },
      });
      return {
        payload: jsonRpcError(
          id,
          -32002,
          err instanceof Error ? err.message : "Failed to list tools",
        ),
        httpStatus: 502,
      };
    }
  }

  if (method === "tools/call") {
    const toolName = String(body.params?.name ?? "");
    let args = (body.params?.arguments ?? {}) as Record<string, unknown>;
    if (!toolName) {
      return {
        payload: jsonRpcError(id, -32602, "tools/call requires params.name"),
        httpStatus: 400,
      };
    }

    let strippedKeys: string[] = [];
    let sourceScopeApplied = false;
    if (toolName === "search") {
      const sanitized = sanitizeStandardSearchArguments(args);
      if ("error" in sanitized) {
        return {
          payload: jsonRpcError(id, -32602, sanitized.error),
          httpStatus: 400,
        };
      }
      const scoped = applyKnowledgeSourceScopeToSearchArgs({ query: sanitized.query });
      args = scoped.args;
      sourceScopeApplied = scoped.scopeApplied;
    } else if (toolName === "fetch") {
      const sanitized = sanitizeStandardFetchArguments(args);
      if ("error" in sanitized) {
        return {
          payload: jsonRpcError(id, -32602, sanitized.error),
          httpStatus: 400,
        };
      }
      args = mapFetchArgumentsForCompanyMcp(sanitized.id);
    } else if (toolName === "search_company_knowledge") {
      const sanitized = sanitizeKnowledgeSearchArguments(args);
      args = sanitized.forwarded;
      strippedKeys = sanitized.strippedKeys;
      const scoped = applyKnowledgeSourceScopeToSearchArgs(args);
      args = scoped.args;
      sourceScopeApplied = scoped.scopeApplied;
      if (typeof args.query !== "string" || !String(args.query).trim()) {
        return {
          payload: jsonRpcError(
            id,
            -32602,
            "search_company_knowledge requires a non-empty arguments.query string",
          ),
          httpStatus: 400,
        };
      }
    }

    const clientRequestId = resolveMcpClientRequestId(request, body);
    const interactionHints = pickInteractionHints(request, body);

    if (isActionControlTool(toolName)) {
      if (
        actor.type === "service" &&
        !actionControlToolAllowed(toolName, actor.identity.scopes)
      ) {
        await logFacadeEvent(env.DB, {
          companyId: resolvedCompanyId,
          actor: actorLabel,
          method,
          toolName,
          status: "denied_or_failed",
          httpStatus: 403,
          detail: {
            reason: "action_control_scope_required",
            toolName,
          },
        });
        const publicError = publicToolErrorMessage(
          403,
          "Action not in service identity scopes",
        );
        return {
          payload: jsonRpcError(id, -32003, publicError.message, {
            httpStatus: 403,
            errorCode: publicError.code,
          }),
          httpStatus: 200,
        };
      }

      const actionResult = await executeActionControlTool(env, {
        companyId: resolvedCompanyId,
        toolName,
        arguments: args,
        actor,
        sourceClient:
          actor.type === "service" ? actor.identity.identityType : "infra-mcp",
        correlationId: clientRequestId ?? undefined,
        interactionId: interactionHints.interactionId ?? undefined,
      });
      const payloadText = JSON.stringify(actionResult.body, null, 2);
      return {
        payload: jsonRpcResult(id, {
          content: [{ type: "text", text: payloadText }],
        }),
        httpStatus: actionResult.status,
      };
    }

    const result = await executeGatewayRequest(env, {
      actor,
      companyId: resolvedCompanyId,
      toolName,
      arguments: args,
      sourceClient:
        actor.type === "service" ? actor.identity.identityType : "infra-mcp",
      clientRequestId,
      interactionId: interactionHints.interactionId,
      parentRequestId: interactionHints.parentRequestId,
      mcpSessionId: interactionHints.mcpSessionId,
    });

    if (result.status !== 200) {
      await logFacadeEvent(env.DB, {
        companyId: resolvedCompanyId,
        actor: actorLabel,
        method,
        toolName,
        status: "denied_or_failed",
        httpStatus: result.status,
        detail: {
          correlationId: result.correlationId,
          requestId: "requestId" in result ? result.requestId : null,
          error: result.error,
          strippedKeys,
          queryPreview:
            typeof args.query === "string" ? args.query.slice(0, 80) : null,
        },
      });
      const publicError = publicToolErrorMessage(
        result.status,
        result.error ?? "Tool call failed",
      );
      return {
        payload: jsonRpcError(id, -32003, publicError.message, {
          correlationId: result.correlationId,
          requestId: "requestId" in result ? result.requestId : undefined,
          httpStatus: result.status,
          errorCode: publicError.code,
          action: "action" in result ? result.action : undefined,
          riskClass: "riskClass" in result ? result.riskClass : undefined,
        }),
        httpStatus: 200, // JSON-RPC errors travel as 200 with error body for MCP clients
      };
    }

    // Body-less idempotent replay previously serialized as "{}" and ChatGPT
    // reported empty knowledge results for every subsequent search.
    if (
      "idempotentReplay" in result &&
      result.idempotentReplay &&
      result.result === undefined
    ) {
      await logFacadeEvent(env.DB, {
        companyId: resolvedCompanyId,
        actor: actorLabel,
        method,
        toolName,
        status: "idempotent_replay_no_body",
        httpStatus: 200,
        detail: {
          correlationId: result.correlationId,
          requestId: result.requestId,
          strippedKeys,
        },
      });
      return {
        payload: jsonRpcResult(id, {
          content: [
            {
              type: "text",
              text: "Idempotent replay: the original tool result body was not retained. Retry without reusing a prior client request id.",
            },
          ],
          isError: true,
          _infra: {
            correlationId: result.correlationId,
            requestId: result.requestId,
            charge: result.charge,
            idempotentReplay: true,
          },
        }),
        httpStatus: 200,
      };
    }

    const payload = result.result;
    const infraMeta = {
      correlationId: result.correlationId,
      requestId: result.requestId,
      charge: result.charge,
    };

    const wrapped =
      toolName === "search"
        ? {
            ...wrapStandardToolResult(toStandardSearchPayload(payload)),
            _infra: infraMeta,
          }
        : toolName === "fetch"
          ? {
              ...wrapStandardToolResult(
                toStandardFetchPayload(
                  payload,
                  typeof args.id === "string" ? args.id : "",
                ),
              ),
              _infra: infraMeta,
            }
          : payload &&
              typeof payload === "object" &&
              "content" in (payload as Record<string, unknown>)
            ? {
                ...(payload as object),
                _infra: infraMeta,
              }
            : {
                content: [
                  {
                    type: "text",
                    text:
                      typeof payload === "string"
                        ? payload
                        : JSON.stringify(payload ?? {}, null, 2),
                  },
                ],
                _infra: infraMeta,
              };

    await logFacadeEvent(env.DB, {
      companyId: resolvedCompanyId,
      actor: actorLabel,
      method,
      toolName,
      status: "ok",
      httpStatus: 200,
      detail: {
        correlationId: result.correlationId,
        requestId: result.requestId,
        strippedKeys,
        queryPreview:
          typeof args.query === "string" ? args.query.slice(0, 80) : null,
        idempotentReplay: Boolean(
          "idempotentReplay" in result && result.idempotentReplay,
        ),
      },
    });

    return {
      payload: jsonRpcResult(id, wrapped),
      httpStatus: 200,
    };
  }

  return {
    payload: jsonRpcError(id, -32601, `Method not found: ${method}`),
    httpStatus: 404,
  };
}

export async function handleInfraMcpHttp(
  env: Env,
  request: Request,
  sessionUser: import("../auth/session").SessionUser | null,
) {
  const existingSession = request.headers.get("Mcp-Session-Id");
  const sessionId = existingSession?.trim() || newId("mcpsess");

  const authHeader = request.headers.get("Authorization");
  const apiKeyHeader =
    request.headers.get("X-Api-Key") ??
    request.headers.get("Api-Key") ??
    request.headers.get("X-Infra-Service-Token");
  const authPresent = Boolean(
    (authHeader && authHeader.trim()) || (apiKeyHeader && apiKeyHeader.trim()),
  );
  const authScheme = authHeader?.toLowerCase().startsWith("bearer ")
    ? "bearer"
    : apiKeyHeader
      ? "api_key_header"
      : authHeader
        ? "authorization_non_bearer"
        : "none";

  const actorResult = await resolveGatewayActor(env, request, sessionUser);
  if ("error" in actorResult) {
    // Always JSON-RPC shaped — ChatGPT clients cannot parse {"error":"..."}.
    const payload = jsonRpcError(null, -32001, actorResult.error, {
      httpStatus: actorResult.status,
      hint:
        actorResult.status === 401
          ? "Send Authorization: Bearer <INFRA service token> from Company Portal → AI Connections."
          : undefined,
    });

    let rpcMethod: string | null = null;
    if (request.method === "POST") {
      try {
        const clone = request.clone();
        const peeked = (await clone.json()) as { method?: string };
        rpcMethod = typeof peeked.method === "string" ? peeked.method : null;
      } catch {
        rpcMethod = null;
      }
    }

    await recordAuditEvent(env.DB, {
      companyId: null,
      eventType: "permission.denied",
      actor: "anonymous",
      resourceType: "mcp_facade",
      resourceId: "auth",
      detail: {
        stage: "mcp_facade.auth_failed",
        status: actorResult.status,
        message: actorResult.error,
        path: new URL(request.url).pathname,
        method: request.method,
        rpcMethod,
        // Never log token values — only presence/scheme.
        authPresent,
        authScheme,
        userAgent: (request.headers.get("User-Agent") ?? "").slice(0, 160),
        accept: (request.headers.get("Accept") ?? "").slice(0, 120),
      },
    });
    return mcpResponse(request, payload, {
      status: actorResult.status,
      sessionId,
      wwwAuthenticate:
        actorResult.status === 401
          ? 'Bearer realm="infra-mcp", error="invalid_token", error_description="INFRA service token required"'
          : undefined,
    });
  }

  if (request.method === "DELETE") {
    // Session termination (Streamable HTTP 2025) — accept and no-op.
    return new Response(null, {
      status: 204,
      headers: { "Mcp-Session-Id": sessionId },
    });
  }

  if (request.method === "GET") {
    // Streamable HTTP: optional server-to-client SSE stream.
    // Do NOT emit legacy HTTP+SSE "endpoint" events — those break ChatGPT
    // when we also advertise a modern protocol version.
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(`: infra-mcp-stream ready ${nowIso()}\n\n`),
        );
        // Keep open briefly then close — clients tolerate short streams.
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Mcp-Session-Id": sessionId,
      },
    });
  }

  if (request.method !== "POST") {
    return mcpResponse(
      request,
      jsonRpcError(null, -32600, `Unsupported HTTP method: ${request.method}`),
      { status: 405, sessionId },
    );
  }

  let body: {
    jsonrpc?: string;
    id?: JsonRpcId;
    method?: string;
    params?: Record<string, unknown>;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return mcpResponse(request, jsonRpcError(null, -32700, "Parse error"), {
      status: 400,
      sessionId,
    });
  }

  const { payload, httpStatus } = await handleInfraMcpJsonRpc(
    env,
    request,
    actorResult,
    body,
  );

  if (httpStatus === 202 && payload == null) {
    return new Response(null, {
      status: 202,
      headers: { "Mcp-Session-Id": sessionId },
    });
  }

  // MCP JSON-RPC application errors use HTTP 200 with error object so clients
  // that only parse SSE/JSON-RPC bodies still see the structured failure.
  const responseStatus =
    payload &&
    typeof payload === "object" &&
    "error" in (payload as object) &&
    httpStatus >= 400 &&
    httpStatus < 500 &&
    httpStatus !== 401 &&
    httpStatus !== 403
      ? 200
      : httpStatus === 401 || httpStatus === 403
        ? httpStatus
        : httpStatus === 202
          ? 202
          : 200;

  return mcpResponse(request, payload, {
    status: responseStatus,
    sessionId,
  });
}
