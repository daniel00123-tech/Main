const ALLOW_HEADERS = "Authorization, Content-Type, MCP-Protocol-Version";
const ALLOW_METHODS = "GET, POST, OPTIONS";

export function oauthCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowOrigin = origin && isAllowedOauthOrigin(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": ALLOW_METHODS,
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Expose-Headers": "WWW-Authenticate",
    "Access-Control-Max-Age": "86400",
  };
}

export function isAllowedOauthOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.hostname === "chatgpt.com" ||
      url.hostname.endsWith(".chatgpt.com") ||
      url.hostname === "chat.openai.com" ||
      url.hostname.endsWith(".openai.com") ||
      url.hostname === "localhost"
    );
  } catch {
    return false;
  }
}

export function withOauthCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(oauthCorsHeaders(request))) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

export function oauthJson(request: Request, data: unknown, status = 200): Response {
  return withOauthCors(
    request,
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

export function oauthOptions(request: Request): Response {
  return withOauthCors(request, new Response(null, { status: 204 }));
}

export function oauthWwwAuthenticate(envOrigin: string): string {
  return `Bearer realm="el-business-mcp", resource_metadata="${envOrigin}/.well-known/oauth-protected-resource"`;
}
