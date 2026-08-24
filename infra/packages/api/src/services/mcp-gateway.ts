/**
 * INFRA MCP protocol facade.
 *
 * ChatGPT / Claude should connect HERE (not to company MCP directly)
 * so every tools/call is authenticated, authorised, metered, and ledgered.
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
} from "./control-plane";

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
  const companyId = actor.type === "service" ? actor.identity.companyId : null;

  if (!companyId && actor.type === "service") {
    return jsonRpcError(id, -32001, "Service identity missing company");
  }

  // Session users must pass companyId in params._meta or X-Infra-Company
  const headerCompany = request.headers.get("X-Infra-Company-Id");
  const resolvedCompanyId =
    companyId ??
    (typeof body.params?.companyId === "string"
      ? body.params.companyId
      : headerCompany);

  if (!resolvedCompanyId) {
    return jsonRpcError(
      id,
      -32602,
      "companyId is required for INFRA MCP gateway",
    );
  }

  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "infra-gateway",
        version: "1.0.0",
      },
      instructions:
        "All tool calls are authorised, metered, and billed by INFRA. Do not call company MCP endpoints directly.",
    });
  }

  if (method === "notifications/initialized" || method === "ping") {
    return jsonRpcResult(id, {});
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
      return jsonRpcError(id, -32004, "No MCP environment for company");
    }

    await ensureDefaultToolAllowlist(env.DB, resolvedCompanyId, mcp.id);

    try {
      const listed = await listMcpTools(
        env,
        mcp.endpointUrl,
        mcp.authSecretRef,
        mcp.serviceBindingRef,
      );

      // Filter to allowlisted tools only
      const allow = await env.DB.prepare(
        `SELECT tool_name FROM mcp_tool_allowlist
         WHERE mcp_environment_id = ? AND enabled = 1`,
      )
        .bind(mcp.id)
        .all();
      const allowed = new Set(
        (allow.results ?? []).map((row) => String(row.tool_name)),
      );

      const tools = listed.tools
        .filter((tool) => allowed.size === 0 || allowed.has(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema ?? {
            type: "object",
            properties: {},
          },
        }));

      return jsonRpcResult(id, { tools });
    } catch (err) {
      return jsonRpcError(
        id,
        -32002,
        err instanceof Error ? err.message : "Failed to list tools",
      );
    }
  }

  if (method === "tools/call") {
    const toolName = String(body.params?.name ?? "");
    const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
    if (!toolName) {
      return jsonRpcError(id, -32602, "tools/call requires params.name");
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
      return jsonRpcError(id, -32003, result.error ?? "Tool call failed", {
        correlationId: result.correlationId,
        requestId: "requestId" in result ? result.requestId : undefined,
        httpStatus: result.status,
      });
    }

    // MCP tools/call result shape
    const payload = result.result;
    if (
      payload &&
      typeof payload === "object" &&
      "content" in (payload as Record<string, unknown>)
    ) {
      return jsonRpcResult(id, {
        ...(payload as object),
        _infra: {
          correlationId: result.correlationId,
          requestId: result.requestId,
          charge: result.charge,
        },
      });
    }

    return jsonRpcResult(id, {
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
    });
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

export async function handleInfraMcpHttp(
  env: Env,
  request: Request,
  sessionUser: import("../auth/session").SessionUser | null,
) {
  const actorResult = await resolveGatewayActor(env, request, sessionUser);
  if ("error" in actorResult) {
    return Response.json(
      { error: actorResult.error },
      { status: actorResult.status },
    );
  }

  if (request.method === "GET") {
    // Minimal SSE hello for clients probing streamable HTTP / SSE
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            `event: endpoint\ndata: ${new URL(request.url).pathname}\n\n`,
          ),
        );
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
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
    return Response.json(
      jsonRpcError(null, -32700, "Parse error"),
      { status: 400 },
    );
  }

  const payload = await handleInfraMcpJsonRpc(env, request, actorResult, body);
  return Response.json(payload);
}
