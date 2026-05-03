import type { Role, SessionUser } from "@/lib/types";

export function hasRole(user: SessionUser | null, roles: Role[]) {
  return Boolean(user && roles.includes(user.role));
}

export function requireRole(user: SessionUser | null, roles: Role[]) {
  if (!hasRole(user, roles)) {
    throw new Error("Forbidden");
  }

  return user as SessionUser;
}
