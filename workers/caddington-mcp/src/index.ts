import { createMcpHandler } from "agents/mcp/server";
import { handleAdminRequest } from "./admin";
import type { Env } from "./db";
import { log } from "./logger";
import { createCaddingtonMcpServer } from "./mcp-server";

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

function checkMcpAuth(request: Request, env: Env): boolean {
  const expected = env.MCP_AUTH_TOKEN;
  if (!expected) return true;
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
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
      return new Response(
        JSON.stringify({ ok: true, service: "caddington-mcp" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.pathname.startsWith("/admin")) {
      return handleAdminRequest(request, env, url);
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      if (!checkMcpAuth(request, env)) {
        log("warn", "mcp_auth_failed", { path: url.pathname });
        return unauthorized();
      }

      const handler = createMcpHandler(
        () => createCaddingtonMcpServer(env),
        { route: "/mcp", legacy: "stateless" }
      );
      return handler(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
