import { cors } from "hono/cors";
import type { Env } from "./env";
import { isOriginAllowed, parseAllowedOrigins } from "./env";

/** Origins used by browser-hosted AI MCP connectors. */
const AI_CLIENT_ORIGINS = [
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://claude.ai",
  "https://www.claude.ai",
];

const MCP_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "Accept",
  "MCP-Protocol-Version",
  "Mcp-Session-Id",
  "Last-Event-ID",
  "X-Api-Key",
  "Api-Key",
  "X-Infra-Client",
  "X-Infra-Request-Id",
  "X-Infra-Company-Id",
  "X-Infra-Service-Token",
];

export function createCorsMiddleware() {
  return cors({
    origin: (origin, c) => {
      const allowedOrigins = [
        ...parseAllowedOrigins(c.env.ALLOWED_ORIGINS),
        ...AI_CLIENT_ORIGINS,
      ];
      if (isOriginAllowed(origin, allowedOrigins)) {
        return origin;
      }
      return "";
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: MCP_ALLOW_HEADERS,
    exposeHeaders: ["Mcp-Session-Id"],
    credentials: true,
  });
}

export type { Env };
