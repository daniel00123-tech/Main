import { createMcpHandler } from "agents/mcp/server";
import { createLogger, mcpUnauthorizedResponse } from "@business-mcp/core";
import type { Env } from "./db";
import { createHtBusinessMcpServer } from "./mcp-server";
import { buildLivenessHealth, buildPublicStatus } from "./status";
import { MCP_NAME } from "./constants";

const logger = createLogger(MCP_NAME);

function unauthorized(): Response {
  return mcpUnauthorizedResponse();
}

/**
 * Preserves existing HT auth behaviour: MCP is open when MCP_AUTH_TOKEN is unset.
 * When set, Bearer token is required. This differs from EL fail-closed production auth.
 */
function checkAuth(request: Request, env: Env): boolean {
  const expected = env.MCP_AUTH_TOKEN;
  if (!expected) {
    return true;
  }
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return false;
  }
  return header.slice("Bearer ".length) === expected;
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

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      if (!checkAuth(request, env)) {
        logger.warn("auth_failed", { path: url.pathname });
        return unauthorized();
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
