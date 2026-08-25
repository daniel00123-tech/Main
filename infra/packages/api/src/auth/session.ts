import { SignJWT, jwtVerify } from "jose";
import type { CompanyRole } from "@infra/shared";

export interface SessionMembership {
  companyId: string;
  role: CompanyRole;
}

export interface SessionUser {
  userId: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
  memberships: SessionMembership[];
}

export interface SessionClaims extends SessionUser {
  iat: number;
  exp: number;
}

const SESSION_COOKIE = "infra_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

function getSecretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(
  user: SessionUser,
  secret: string,
): Promise<string> {
  return new SignJWT({
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
    isPlatformAdmin: user.isPlatformAdmin,
    memberships: user.memberships,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecretKey(secret));
}

export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(secret), {
      algorithms: ["HS256"],
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

    return {
      userId: payload.userId,
      email: payload.email,
      displayName: payload.displayName,
      isPlatformAdmin: payload.isPlatformAdmin,
      memberships: payload.memberships as SessionMembership[],
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
): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    crossOrigin ? "SameSite=None" : "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];

  if (secure || crossOrigin) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

export function buildClearSessionCookie(secure: boolean, crossOrigin = false): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "Path=/",
    crossOrigin ? "SameSite=None" : "SameSite=Lax",
    "Max-Age=0",
  ];

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
