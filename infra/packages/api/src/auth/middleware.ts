import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import {
  USER_ACTIVITY_HEADER,
  buildClearSessionCookie,
  buildSessionCookie,
  createSessionToken,
  credentialsVersionFromHash,
  nowUnixSeconds,
  readSessionCookie,
  sessionPublicMeta,
  shouldTouchSession,
  verifySessionToken,
  type SessionPublicMeta,
  type SessionUser,
  type VerifiedSession,
} from "./session";
import { getUserById } from "./users";

export type AuthVariables = {
  user: SessionUser;
  session: VerifiedSession;
  sessionMeta: SessionPublicMeta;
};

function isSecureRequest(url: URL): boolean {
  return url.protocol === "https:";
}

export const loadSession = createMiddleware<{ Bindings: Env; Variables: Partial<AuthVariables> }>(
  async (c, next) => {
    const token = readSessionCookie(c.req.header("Cookie") ?? null);
    if (token) {
      const verified = await verifySessionToken(token, c.env.SESSION_SECRET);
      if (verified) {
        c.set("user", verified.user);
        c.set("session", verified);
        c.set("sessionMeta", sessionPublicMeta(verified));
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

    const verified = await verifySessionToken(token, c.env.SESSION_SECRET);
    if (!verified) {
      clearSessionCookie(c);
      return c.json({ error: "Invalid or expired session" }, 401);
    }

    const dbUser = await getUserById(c.env.DB, verified.user.userId);
    if (!dbUser || dbUser.status !== "active") {
      return c.json({ error: "Account is disabled or unavailable" }, 401);
    }

    const currentCredentialsVersion = credentialsVersionFromHash(dbUser.passwordHash);
    if ((verified.user.credentialsVersion ?? "") !== currentCredentialsVersion) {
      clearSessionCookie(c);
      return c.json({ error: "Invalid or expired session" }, 401);
    }

    const now = nowUnixSeconds();
    const touched =
      requestCountsAsUserActivity(c.req.path, c.req.header(USER_ACTIVITY_HEADER)) &&
      shouldTouchSession(verified.lastActivity, now)
        ? await createSessionToken(verified.user, c.env.SESSION_SECRET, {
            authTime: verified.authTime,
            lastActivity: now,
            now,
          })
        : null;
    if (touched) {
      setSessionCookie(c, touched);
      verified.lastActivity = now;
    }

    c.set("user", verified.user);
    c.set("session", verified);
    c.set("sessionMeta", sessionPublicMeta(verified));
    await next();
  },
);

export function requestCountsAsUserActivity(
  path: string,
  activityHeader: string | undefined,
): boolean {
  if (activityHeader === "1") return true;
  return path === "/api/auth/me" || path === "/api/auth/activity";
}

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

function portalCookieDomain(env: {
  PORTAL_COOKIE_DOMAIN?: string;
  PORTAL_BASE_DOMAIN?: string;
}): string | null {
  const explicit = env.PORTAL_COOKIE_DOMAIN?.trim();
  if (explicit) return explicit.startsWith(".") ? explicit : `.${explicit}`;
  const base = env.PORTAL_BASE_DOMAIN?.trim();
  if (base) return `.${base}`;
  return null;
}

function sessionCookieOptions(c: {
  req: { url: string };
  env: { COOKIE_CROSS_ORIGIN?: string; PORTAL_COOKIE_DOMAIN?: string; PORTAL_BASE_DOMAIN?: string };
}) {
  const secure = isSecureRequest(new URL(c.req.url));
  const crossOrigin = isCrossOriginCookies(c.env);
  return {
    secure,
    crossOrigin,
    cookieDomain: crossOrigin ? null : portalCookieDomain(c.env),
  };
}

export function setSessionCookie(
  c: {
    header: (name: string, value: string) => void;
    req: { url: string };
    env: {
      COOKIE_CROSS_ORIGIN?: string;
      PORTAL_COOKIE_DOMAIN?: string;
      PORTAL_BASE_DOMAIN?: string;
    };
  },
  token: string,
) {
  const opts = sessionCookieOptions(c);
  c.header(
    "Set-Cookie",
    buildSessionCookie(token, opts.secure, opts.crossOrigin, opts.cookieDomain),
  );
}

export function clearSessionCookie(c: {
  header: (name: string, value: string) => void;
  req: { url: string };
  env: {
    COOKIE_CROSS_ORIGIN?: string;
    PORTAL_COOKIE_DOMAIN?: string;
    PORTAL_BASE_DOMAIN?: string;
  };
}) {
  const opts = sessionCookieOptions(c);
  c.header(
    "Set-Cookie",
    buildClearSessionCookie(opts.secure, opts.crossOrigin, opts.cookieDomain),
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
