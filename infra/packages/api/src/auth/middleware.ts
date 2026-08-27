import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  readSessionCookie,
  verifySessionToken,
  type SessionUser,
} from "./session";
import { getUserById } from "./users";

export type AuthVariables = {
  user: SessionUser;
};

function isSecureRequest(url: URL): boolean {
  return url.protocol === "https:";
}

export const loadSession = createMiddleware<{ Bindings: Env; Variables: Partial<AuthVariables> }>(
  async (c, next) => {
    const token = readSessionCookie(c.req.header("Cookie") ?? null);
    if (token) {
      const user = await verifySessionToken(token, c.env.SESSION_SECRET);
      if (user) {
        c.set("user", user);
      }
    }
    await next();
  },
);

export const requireAuth = createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(
  async (c, next) => {
    const token = readSessionCookie(c.req.header("Cookie") ?? null);
    if (!token) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const user = await verifySessionToken(token, c.env.SESSION_SECRET);
    if (!user) {
      return c.json({ error: "Invalid or expired session" }, 401);
    }

    const dbUser = await getUserById(c.env.DB, user.userId);
    if (!dbUser || dbUser.status !== "active") {
      return c.json({ error: "Account is disabled or unavailable" }, 401);
    }

    c.set("user", user);
    await next();
  },
);

export const requirePlatformAdmin = createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(
  async (c, next) => {
    const user = c.get("user");
    if (!user.isPlatformAdmin) {
      return c.json({ error: "Platform administrator access required" }, 403);
    }
    await next();
  },
);

function isCrossOriginCookies(env: { COOKIE_CROSS_ORIGIN?: string }): boolean {
  return env.COOKIE_CROSS_ORIGIN === "true";
}

export function setSessionCookie(
  c: {
    header: (name: string, value: string) => void;
    req: { url: string };
    env: { COOKIE_CROSS_ORIGIN?: string };
  },
  token: string,
) {
  const secure = isSecureRequest(new URL(c.req.url));
  c.header(
    "Set-Cookie",
    buildSessionCookie(token, secure, isCrossOriginCookies(c.env)),
  );
}

export function clearSessionCookie(c: {
  header: (name: string, value: string) => void;
  req: { url: string };
  env: { COOKIE_CROSS_ORIGIN?: string };
}) {
  const secure = isSecureRequest(new URL(c.req.url));
  c.header(
    "Set-Cookie",
    buildClearSessionCookie(secure, isCrossOriginCookies(c.env)),
  );
}

export function requireCompanyAccess(companyId: string) {
  return createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(
    async (c, next) => {
      const user = c.get("user");
      if (user.isPlatformAdmin) {
        await next();
        return;
      }

      const allowed = user.memberships.some(
        (membership) => membership.companyId === companyId,
      );

      if (!allowed) {
        return c.json({ error: "Access to this company is denied" }, 403);
      }

      await next();
    },
  );
}
