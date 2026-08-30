import { createMcpHandler } from "agents/mcp/server";
import {
  checkMcpAuth,
  createLogger,
  mcpUnauthorizedResponse,
} from "@business-mcp/core";
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

const logger = createLogger(MCP_NAME);

/** Production MCP always fails closed when MCP_AUTH_TOKEN is missing. */
function checkElMcpAuth(request: Request, env: Env): boolean {
  return checkMcpAuth(request, env.MCP_AUTH_TOKEN, { requireToken: true });
}

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

    if (url.pathname.startsWith("/admin")) {
      return runWithRbacContext(env, request, () => handleAdminRequest(request, env, url));
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      if (!checkElMcpAuth(request, env)) {
        logger.warn("mcp_auth_failed", { path: url.pathname });
        return mcpUnauthorizedResponse();
      }

      return runWithRbacContext(env, request, () => {
        const handler = createMcpHandler(
          () => createElBusinessMcpServer(env),
          { route: "/mcp", legacy: "stateless" }
        );
        return handler(request, env, ctx);
      });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
