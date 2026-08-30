import { createMcpHandler } from "agents/mcp/server";
import { createLogger } from "@business-mcp/core";
import {
  buildLivenessHealth,
  buildPublicStatus,
  handleAdminRequest,
} from "./admin";
import type { Env } from "./env";
import { createElBusinessMcpServer } from "./mcp-server";
import { MCP_NAME } from "./constants";
import { handleXeroOAuthCallback } from "./xero/http";
import { runWithRbacContext } from "./rbac/context";
import {
  gateMcpRequest,
  handleMcpOAuthRequest,
  isMcpOAuthPath,
  mcpOAuthUnauthorizedResponse,
} from "./oauth";
import { peekToolsCall, reportInfraMcpUsage, usageSuccessFromMcpResponse } from "./infra/usage";

const logger = createLogger(MCP_NAME);

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return buildLivenessHealth(env);
    }

    if (url.pathname === "/status") {
      return buildPublicStatus(env);
    }

    if (url.pathname === "/oauth/xero/callback") {
      return handleXeroOAuthCallback(request, env);
    }

    if (isMcpOAuthPath(url.pathname)) {
      return handleMcpOAuthRequest(request, env, url);
    }

    if (url.pathname.startsWith("/admin")) {
      return runWithRbacContext(env, request, () => handleAdminRequest(request, env, url));
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const gate = await gateMcpRequest(request, env);
      if (!gate.allowed) {
        logger.warn("mcp_auth_failed", { path: url.pathname, reason: gate.reason });
        return mcpOAuthUnauthorizedResponse(env, gate.reason);
      }

      const call = await peekToolsCall(request);
      const started = Date.now();
      const response = await runWithRbacContext(
        env,
        request,
        () => {
          const handler = createMcpHandler(
            () => createElBusinessMcpServer(env),
            { route: "/mcp", legacy: "stateless" }
          );
          return handler(request, env, ctx);
        },
        gate.actor
      );
      if (call.method === "tools/call" && call.toolName) {
        ctx.waitUntil(
          (async () => {
            let parsed: unknown = null;
            try {
              parsed = await response.clone().json();
            } catch {
              parsed = null;
            }
            await reportInfraMcpUsage(env, {
              actor: gate.actor,
              toolName: call.toolName!,
              success: usageSuccessFromMcpResponse(response.status, parsed),
              durationMs: Date.now() - started,
              correlationId: gate.actor.correlationId,
              requestId: request.headers.get("x-request-id"),
              client: "chatgpt",
            });
          })()
        );
      }
      return response;
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
