import { UnauthorizedError } from "../types/errors";

export interface McpAuthOptions {
  /** When true, reject all requests if MCP_AUTH_TOKEN is not configured. */
  requireToken?: boolean;
}

export function checkMcpAuth(
  request: Request,
  expectedToken: string | undefined,
  options: McpAuthOptions = {}
): boolean {
  const requireToken = options.requireToken ?? false;

  if (!expectedToken?.trim()) {
    return !requireToken;
  }

  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length) === expectedToken;
}

export function assertMcpAuth(
  request: Request,
  expectedToken: string | undefined,
  options: McpAuthOptions = {}
): void {
  if (!checkMcpAuth(request, expectedToken, options)) {
    throw new UnauthorizedError();
  }
}

export function mcpUnauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

export function checkAdminAuth(
  request: Request,
  expectedToken: string | undefined
): boolean {
  if (!expectedToken?.trim()) return false;
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length) === expectedToken;
}

export function adminUnauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
