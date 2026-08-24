import { cors } from "hono/cors";
import type { Env } from "./env";
import { isOriginAllowed, parseAllowedOrigins } from "./env";

export function createCorsMiddleware() {
  return cors({
    origin: (origin, c) => {
      const allowedOrigins = parseAllowedOrigins(c.env.ALLOWED_ORIGINS);
      if (isOriginAllowed(origin, allowedOrigins)) {
        return origin;
      }
      return "";
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  });
}

export type { Env };
