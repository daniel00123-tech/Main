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
  getMcpEnvironment,
  listMcpEnvironments,
  recordAuditEvent,
} from "./control-plane";
import {
  evaluateServiceActionPermission,
  serviceHasActionScope,
} from "./service-identities";
import { newId, nowIso } from "../db/mappers";

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
    search_company_knowledge:
      "Search this company's indexed knowledge documents (policies, project docs, spend limits, approvals, etc.). Use when the user asks about company knowledge. Returns matching excerpts with source document titles.",
    get_knowledge_document:
      "Read a specific company knowledge document by identifier or title after locating it with search_company_knowledge.",
    database_summary:
      "Summarise available company business-data collections exposed through the knowledge layer.",
    system_health:
      "Non-billable health check for the company MCP connection through INFRA. Does not search documents and does not debit the wallet.",
  };
  const enriched = defaults[toolName];
  if (enriched) return enriched;
  if (upstreamDescription && upstreamDescription.trim()) {
    return upstreamDescription.trim();
  }
  return `Company capability: ${toolName}`;
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
  if (toolName === "search_company_knowledge") return "knowledge.search";
  if (toolName === "get_knowledge_document" || toolName === "database_summary") {
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
  const resolvedCompanyId =
    companyId ??
    (typeof body.params?.companyId === "string"
      ? body.params.companyId
      : headerCompany);

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
            "All tool calls are authorised, metered, and billed by INFRA. Do not call company MCP endpoints directly.",
        },
        instructions:
          "All tool calls are authorised, metered, and billed by INFRA. Do not call company MCP endpoints directly.",
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

        tools.push({
          name: tool.name,
          description: enrichMcpToolDescription(tool.name, tool.description),
          inputSchema: {
            ...rawSchema,
            type: typeof rawSchema.type === "string" ? rawSchema.type : "object",
          },
        });
      }

      await logFacadeEvent(env.DB, {
        companyId: resolvedCompanyId,
        actor: actorLabel,
        method,
        status: "ok",
        httpStatus: 200,
        detail: { toolNames: tools.map((t) => t.name), mcpId: mcp.id },
      });

      return {
        payload: jsonRpcResult(id, { tools }),
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
    const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
    if (!toolName) {
      return {
        payload: jsonRpcError(id, -32602, "tools/call requires params.name"),
        httpStatus: 400,
      };
    }

    const meta =
      body.params?._meta && typeof body.params._meta === "object"
        ? (body.params._meta as Record<string, unknown>)
        : {};
    const clientRequestId =
      (typeof body.params?.requestId === "string"
        ? body.params.requestId
        : null) ??
      (typeof meta.clientRequestId === "string"
        ? meta.clientRequestId
        : null) ??
      (id != null ? `mcp_${String(id)}` : null);

    const result = await executeGatewayRequest(env, {
      actor,
      companyId: resolvedCompanyId,
      toolName,
      arguments: args,
      sourceClient:
        actor.type === "service" ? actor.identity.identityType : "infra-mcp",
      clientRequestId,
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
        },
      });
      return {
        payload: jsonRpcError(id, -32003, result.error ?? "Tool call failed", {
          correlationId: result.correlationId,
          requestId: "requestId" in result ? result.requestId : undefined,
          httpStatus: result.status,
          action: "action" in result ? result.action : undefined,
          riskClass: "riskClass" in result ? result.riskClass : undefined,
        }),
        httpStatus: 200, // JSON-RPC errors travel as 200 with error body for MCP clients
      };
    }

    const payload = result.result;
    const wrapped =
      payload &&
      typeof payload === "object" &&
      "content" in (payload as Record<string, unknown>)
        ? {
            ...(payload as object),
            _infra: {
              correlationId: result.correlationId,
              requestId: result.requestId,
              charge: result.charge,
            },
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
            _infra: {
              correlationId: result.correlationId,
              requestId: result.requestId,
              charge: result.charge,
            },
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
