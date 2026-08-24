import { createMcpHandler } from "agents/mcp/server";
import {
  checkMcpAuth,
  createLogger,
  mcpUnauthorizedResponse,
} from "@business-mcp/core";
import type { Env } from "./db";
import { createHtBusinessMcpServer } from "./mcp-server";
import { buildLivenessHealth, buildPublicStatus } from "./status";
import { MCP_NAME } from "./constants";

const logger = createLogger(MCP_NAME);

/** Production MCP always fails closed when MCP_AUTH_TOKEN is missing. */
function checkHtMcpAuth(request: Request, env: Env): boolean {
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
      if (!checkHtMcpAuth(request, env)) {
        logger.warn("status_auth_failed", { path: url.pathname });
        return mcpUnauthorizedResponse();
      }
      return buildPublicStatus(env);
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      if (!checkHtMcpAuth(request, env)) {
        logger.warn("mcp_auth_failed", { path: url.pathname });
        return mcpUnauthorizedResponse();
      }

      const handler = createMcpHandler(
        () => createHtBusinessMcpServer(env),
        {
          route: "/mcp",
          legacy: "stateless",
        }
      );

      return handler(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
