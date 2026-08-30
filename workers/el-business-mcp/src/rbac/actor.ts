import type { ElvexRole } from "./roles";

export type PrincipalType = "user" | "service";

export type IdentitySource =
  | "d1"
  | "signed_infra"
  | "infra_oauth"
  | "microsoft_oidc"
  | "service_token"
  | "injected"
  | "none";

export type ElvexActor = {
  principalType: PrincipalType;
  actorId: string;
  email: string | null;
  displayName: string | null;
  role: ElvexRole | null;
  /** Explicit grants for service principals only. Users use role presets. */
  serviceCapabilities?: string[];
  identityBound: boolean;
  identitySource: IdentitySource;
  companyId: string;
  correlationId: string | null;
  microsoftOid?: string | null;
};

export const ELVEX_COMPANY_ID = "co_el";
export const ELVEX_COMPANY_SLUG = "el-business";
export const ELVEX_COMPANY_NAME = "Elvex Property Services Ltd";

export function unboundActor(
  correlationId: string | null = null,
  extra: Partial<ElvexActor> = {}
): ElvexActor {
  return {
    principalType: extra.principalType ?? "user",
    actorId: extra.actorId ?? "anonymous",
    email: extra.email ?? null,
    displayName: extra.displayName ?? null,
    role: null,
    identityBound: false,
    identitySource: extra.identitySource ?? "none",
    companyId: ELVEX_COMPANY_ID,
    correlationId: extra.correlationId ?? correlationId,
    microsoftOid: extra.microsoftOid ?? null,
  };
}
