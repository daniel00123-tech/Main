import { SignJWT, jwtVerify } from "jose";
import type { CompanyRole } from "@infra/shared";

export interface SessionMembership {
  companyId: string;
  role: CompanyRole;
  customRoleId?: string | null;
  teamId?: string | null;
}

export interface SessionUser {
  userId: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
  memberships: SessionMembership[];
  /** Fingerprint of stored password hash — sessions invalidate when password changes. */
  credentialsVersion?: string;
}

export interface SessionClaims extends SessionUser {
  iat: number;
  exp: number;
}

export interface VerifiedSession {
  user: SessionUser;
  authTime: number;
  lastActivity: number;
  exp: number;
}

export interface SessionPublicMeta {
  idleTimeoutSeconds: number;
  absoluteTimeoutSeconds: number;
  expiresAt: string;
  idleExpiresAt: string;
}

const SESSION_COOKIE = "infra_session";

/** Hard cap from original login. Matches the historical JWT lifetime. */
export const SESSION_ABSOLUTE_SECONDS = 60 * 60 * 12;
/** Server-enforced inactivity window. Cookie Max-Age matches this so a closed app expires. */
export const SESSION_IDLE_SECONDS = 60 * 30;
/** Avoid rewriting the cookie on every authenticated request. */
export const SESSION_TOUCH_MIN_INTERVAL_SECONDS = 60;

export const USER_ACTIVITY_HEADER = "X-Infra-User-Activity";

function getSecretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export function credentialsVersionFromHash(passwordHash: string): string {
  return passwordHash.slice(0, 16);
}

export function nowUnixSeconds(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000);
}

export function evaluateSessionTiming(
  input: { authTime?: unknown; lastActivity?: unknown; iat?: unknown },
  now = nowUnixSeconds(),
): { ok: true; authTime: number; lastActivity: number } | { ok: false; reason: "idle" | "absolute" } {
  const iat = typeof input.iat === "number" ? input.iat : 0;
  const authTime = typeof input.authTime === "number" ? input.authTime : iat;
  const lastActivity = typeof input.lastActivity === "number" ? input.lastActivity : iat;
  if (!authTime || now - authTime > SESSION_ABSOLUTE_SECONDS) {
    return { ok: false, reason: "absolute" };
  }
  if (!lastActivity || now - lastActivity > SESSION_IDLE_SECONDS) {
    return { ok: false, reason: "idle" };
  }
  return { ok: true, authTime, lastActivity };
}

export function sessionPublicMeta(
  timing: { authTime: number; lastActivity: number },
): SessionPublicMeta {
  return {
    idleTimeoutSeconds: SESSION_IDLE_SECONDS,
    absoluteTimeoutSeconds: SESSION_ABSOLUTE_SECONDS,
    expiresAt: new Date((timing.authTime + SESSION_ABSOLUTE_SECONDS) * 1000).toISOString(),
    idleExpiresAt: new Date((timing.lastActivity + SESSION_IDLE_SECONDS) * 1000).toISOString(),
  };
}

export function shouldTouchSession(lastActivity: number, now = nowUnixSeconds()): boolean {
  return now - lastActivity >= SESSION_TOUCH_MIN_INTERVAL_SECONDS;
}

export async function createSessionToken(
  user: SessionUser,
  secret: string,
  options?: { authTime?: number; lastActivity?: number; now?: number },
): Promise<string> {
  const now = options?.now ?? nowUnixSeconds();
  const authTime = options?.authTime ?? now;
  const lastActivity = options?.lastActivity ?? now;
  const exp = authTime + SESSION_ABSOLUTE_SECONDS;
  return new SignJWT({
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
    isPlatformAdmin: user.isPlatformAdmin,
    memberships: user.memberships,
    credentialsVersion: user.credentialsVersion,
    authTime,
    lastActivity,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(getSecretKey(secret));
}

export async function verifySessionToken(
  token: string,
  secret: string,
  now = nowUnixSeconds(),
): Promise<VerifiedSession | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(secret), {
      algorithms: ["HS256"],
      currentDate: new Date(now * 1000),
    });

    if (
      typeof payload.userId !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.displayName !== "string" ||
      typeof payload.isPlatformAdmin !== "boolean" ||
      !Array.isArray(payload.memberships)
    ) {
      return null;
    }

    const timing = evaluateSessionTiming(payload, now);
    if (!timing.ok) {
      return null;
    }

    return {
      user: {
        userId: payload.userId,
        email: payload.email,
        displayName: payload.displayName,
        isPlatformAdmin: payload.isPlatformAdmin,
        memberships: payload.memberships as SessionMembership[],
        credentialsVersion:
          typeof payload.credentialsVersion === "string"
            ? payload.credentialsVersion
            : undefined,
      },
      authTime: timing.authTime,
      lastActivity: timing.lastActivity,
      exp: typeof payload.exp === "number" ? payload.exp : timing.authTime + SESSION_ABSOLUTE_SECONDS,
    };
  } catch {
    return null;
  }
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}

export function buildSessionCookie(
  token: string,
  secure: boolean,
  crossOrigin = false,
  cookieDomain?: string | null,
  maxAgeSeconds = SESSION_IDLE_SECONDS,
): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    crossOrigin ? "SameSite=None" : "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];

  if (cookieDomain) {
    parts.push(`Domain=${cookieDomain}`);
  }

  if (secure || crossOrigin) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

export function buildClearSessionCookie(
  secure: boolean,
  crossOrigin = false,
  cookieDomain?: string | null,
): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "Path=/",
    crossOrigin ? "SameSite=None" : "SameSite=Lax",
    "Max-Age=0",
  ];

  if (cookieDomain) {
    parts.push(`Domain=${cookieDomain}`);
  }

  if (secure || crossOrigin) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      return rest.join("=") || null;
    }
  }

  return null;
}
