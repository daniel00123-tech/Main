/**
 * INFRA MCP protocol facade (Streamable HTTP).
 *
 * ChatGPT / Claude must connect HERE (not to company MCP directly)
 * so every tools/call is authenticated, authorised, metered, and ledgered.
 *
 * Wire format matches production Caddington MCP behaviour that ChatGPT already
 * speaks: Accept application/json + text/event-stream, SSE responses preferred.
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

function wantsSse(request: Request): boolean {
  const accept = (request.headers.get("Accept") ?? "").toLowerCase();
  // Prefer SSE when client advertises it (ChatGPT / Caddington-compatible clients).
  if (accept.includes("text/event-stream")) return true;
  // Strict event-stream-only Accept
  if (accept.trim() === "text/event-stream") return true;
  return false;
}

function mcpResponse(
  request: Request,
  payload: unknown,
  init?: { status?: number; sessionId?: string | null },
): Response {
  const status = init?.status ?? 200;
  const headers = new Headers();
  if (init?.sessionId) {
    headers.set("Mcp-Session-Id", init.sessionId);
  }

  if (wantsSse(request)) {
    headers.set("Content-Type", "text/event-stream");
    headers.set("Cache-Control", "no-cache");
    const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    return new Response(body, { status, headers });
  }

  headers.set("Content-Type", "application/json");
  return Response.json(payload, { status, headers });
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

  if (method === "notifications/initialized" || method === "ping") {
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

        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema ?? {
            type: "object",
            properties: {},
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

  const actorResult = await resolveGatewayActor(env, request, sessionUser);
  if ("error" in actorResult) {
    // Always JSON-RPC shaped — ChatGPT clients cannot parse {"error":"..."}.
    const payload = jsonRpcError(null, -32001, actorResult.error, {
      httpStatus: actorResult.status,
    });
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
      },
    });
    return mcpResponse(request, payload, {
      status: actorResult.status,
      sessionId,
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
        : 200;

  return mcpResponse(request, payload, {
    status: responseStatus,
    sessionId,
  });
}
