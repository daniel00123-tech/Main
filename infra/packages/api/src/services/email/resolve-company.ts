import { listMembershipsForUser } from "../../auth/users";
import { getCompanyByPortalSubdomain } from "../tenant-provisioning";
import { getCompanyById } from "../control-plane";
import { getCompanyEmailConfig } from "./company-config";
import { portalBaseDomain } from "../public-urls";
import type { Env } from "../../env";

export async function resolveCompanyIdFromPortalOrigin(
  env: Env,
  db: D1Database,
  origin?: string | null,
): Promise<string | null> {
  if (!origin?.trim()) return null;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    const base = portalBaseDomain(env).toLowerCase();
    if (!host.endsWith(`.${base}`)) return null;
    const subdomain = host.slice(0, -(base.length + 1));
    if (!subdomain || subdomain.includes(".")) return null;
    const company = await getCompanyByPortalSubdomain(db, subdomain);
    return company?.id ?? null;
  } catch {
    return null;
  }
}

/** Resolve which company should send a password-reset email for a user. */
export async function resolvePasswordResetCompanyId(
  env: Env,
  db: D1Database,
  input: { userId: string; origin?: string | null },
): Promise<string | null> {
  const fromOrigin = await resolveCompanyIdFromPortalOrigin(env, db, input.origin);
  if (fromOrigin) {
    const config = await getCompanyEmailConfig(db, fromOrigin);
    const memberships = await listMembershipsForUser(db, input.userId);
    const isMember = memberships.some((m) => m.companyId === fromOrigin);
    if (config?.enabled && isMember) return fromOrigin;
  }

  const memberships = await listMembershipsForUser(db, input.userId);
  for (const membership of memberships) {
    const config = await getCompanyEmailConfig(db, membership.companyId);
    if (config?.enabled) return membership.companyId;
  }

  return null;
}

export async function companyDisplayNameForEmail(
  db: D1Database,
  companyId: string,
): Promise<string> {
  const company = await getCompanyById(db, companyId);
  return company?.name?.trim() || "Your company";
}

export function buildPasswordResetUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/setup-password?token=${encodeURIComponent(token)}`;
}

export function buildInvitationSetupUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/setup-password?token=${encodeURIComponent(token)}`;
}
