import type { ElvexRole } from "./roles";

export type PrincipalType = "user" | "service";

export type ElvexActor = {
  principalType: PrincipalType;
  actorId: string;
  email: string | null;
  displayName: string | null;
  role: ElvexRole | null;
  /** Explicit grants for service principals only. Users use role presets. */
  serviceCapabilities?: string[];
  identityBound: boolean;
  identitySource: "d1" | "signed_infra" | "injected" | "none";
  companyId: string;
  correlationId: string | null;
};

export const ELVEX_COMPANY_ID = "co_el";
export const ELVEX_COMPANY_SLUG = "el-business";
export const ELVEX_COMPANY_NAME = "Elvex Property Services Ltd";

export function unboundActor(correlationId: string | null = null): ElvexActor {
  return {
    principalType: "user",
    actorId: "anonymous",
    email: null,
    displayName: null,
    role: null,
    identityBound: false,
    identitySource: "none",
    companyId: ELVEX_COMPANY_ID,
    correlationId,
  };
}
