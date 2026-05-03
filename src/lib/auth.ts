import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { appConfig } from "./config";
import { prisma } from "./prisma";
import { isRole, type Role } from "./types";

const sessionCookieName = "contractor_marketplace_session";
const encoder = new TextEncoder();

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
};

type SessionPayload = {
  user: SessionUser;
};

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

export async function createSessionToken(user: SessionUser) {
  return new SignJWT({ user } satisfies SessionPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${appConfig.sessionTtlHours}h`)
    .sign(encoder.encode(appConfig.authSecret));
}

export async function setSession(user: SessionUser) {
  const token = await createSessionToken(user);
  const cookieStore = await cookies();
  cookieStore.set(sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: appConfig.sessionTtlHours * 60 * 60,
  });
}

export async function clearSession() {
  const cookieStore = await cookies();
  cookieStore.delete(sessionCookieName);
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  if (!token) {
    return null;
  }

  try {
    const verified = await jwtVerify(token, encoder.encode(appConfig.authSecret));
    const payload = verified.payload as unknown as SessionPayload;
    if (!isRole(payload.user.role)) return null;
    return payload.user;
  } catch {
    return null;
  }
}

export async function requireUser(roles?: Role[]) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    throw new Error("Authentication required");
  }
  if (roles && !roles.includes(sessionUser.role)) {
    throw new Error("Insufficient permissions");
  }
  return sessionUser;
}

export async function requirePageUser(roles?: Role[]) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    redirect("/login");
  }
  if (roles && !roles.includes(sessionUser.role)) {
    redirect("/dashboard");
  }
  return sessionUser;
}

export async function authenticate(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return null;
  }
  if (!isRole(user.role)) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as Role,
  } satisfies SessionUser;
}

export const authCookieName = sessionCookieName;
