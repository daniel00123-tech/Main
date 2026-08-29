/** Mirrors server policy in `packages/api/src/auth/session.ts`. UI must not invent a different timeout. */
export const SESSION_IDLE_SECONDS = 30 * 60;
export const SESSION_ABSOLUTE_SECONDS = 12 * 60 * 60;
export const SESSION_ACTIVITY_HEADER = "X-Infra-User-Activity";
export const SESSION_EXPIRED_STORAGE_KEY = "infra.session.expired";

export type SessionPolicy = {
  idleTimeoutSeconds: number;
  absoluteTimeoutSeconds: number;
  expiresAt?: string;
  idleExpiresAt?: string;
};

export function sessionPolicyFromUser(session?: SessionPolicy | null): SessionPolicy {
  return {
    idleTimeoutSeconds: session?.idleTimeoutSeconds ?? SESSION_IDLE_SECONDS,
    absoluteTimeoutSeconds: session?.absoluteTimeoutSeconds ?? SESSION_ABSOLUTE_SECONDS,
    expiresAt: session?.expiresAt,
    idleExpiresAt: session?.idleExpiresAt,
  };
}

export function loginPathForLocation(pathname: string): string {
  return pathname.startsWith("/portal") ? "/portal/login" : "/login";
}
