import type { CompanyRole } from "@infra/shared";
import type { SessionUser } from "../../auth/session";
import { getUserById } from "../../auth/users";
import { getCompanyById, getCompanyBySlug } from "../control-plane";
import type { LiveMcpPrincipal } from "./types";

export type LivePrincipalResult =
  | { ok: true; principal: LiveMcpPrincipal }
  | { ok: false; reason: string };

export async function resolveLiveMcpPrincipal(
  db: D1Database,
  input: { userId: string; companyId: string },
): Promise<LivePrincipalResult> {
  const user = await getUserById(db, input.userId);
  if (!user) return { ok: false, reason: "unknown_user" };
  if (user.status !== "active") return { ok: false, reason: "user_disabled" };

  const company = await getCompanyById(db, input.companyId);
  if (!company) return { ok: false, reason: "unknown_company" };

  const membership = await db
    .prepare(
      `SELECT role, status FROM company_memberships
       WHERE user_id = ? AND company_id = ?`,
    )
    .bind(user.id, company.id)
    .first();
  if (!membership) return { ok: false, reason: "no_membership" };
  if (String(membership.status) !== "active") {
    return { ok: false, reason: "membership_disabled" };
  }
  const role = String(membership.role ?? "").trim();
  if (!role) return { ok: false, reason: "unknown_role" };

  return {
    ok: true,
    principal: {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      companyId: company.id,
      companySlug: company.slug,
      companyName: company.name,
      role,
      client: "chatgpt",
    },
  };
}

export async function resolveCompanyForMcpResource(
  db: D1Database,
  input: { companySlug?: string | null; resource?: string | null },
) {
  const slug = input.companySlug?.trim().toLowerCase();
  if (slug) {
    return getCompanyBySlug(db, slug);
  }
  const resource = input.resource?.trim().toLowerCase() ?? "";
  if (resource.includes("el-business") || resource.includes("elvex")) {
    return getCompanyBySlug(db, "el-business");
  }
  if (resource.includes("caddington")) {
    return getCompanyBySlug(db, "caddington");
  }
  if (resource.includes("ht-business") || resource.includes("/ht")) {
    return getCompanyBySlug(db, "ht-business");
  }
  return null;
}

export function sessionUserFromPrincipal(principal: LiveMcpPrincipal): SessionUser {
  return {
    userId: principal.userId,
    email: principal.email,
    displayName: principal.displayName,
    isPlatformAdmin: false,
    memberships: [
      {
        companyId: principal.companyId,
        role: principal.role as CompanyRole,
      },
    ],
  };
}
