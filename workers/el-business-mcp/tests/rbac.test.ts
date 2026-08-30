import { afterEach, describe, expect, it } from "vitest";
import { can } from "../src/rbac/authorize";
import {
  actorFromAssignment,
  extractUntrustedRole,
  signIdentityHeaders,
  signUserSync,
  verifyUserSync,
} from "../src/rbac/identity";
import { unboundActor } from "../src/rbac/actor";
import { recordPermissionAudit } from "../src/rbac/audit";
import { ELVEX_ROLES, type ElvexRole } from "../src/rbac/roles";
import type { ElvexCapability } from "../src/rbac/capabilities";
import { mailboxCapabilities } from "../src/rbac/mailbox";
import { xeroCapabilityForTool } from "../src/rbac/xero";
import { filterKnowledgeItems } from "../src/rbac/knowledge";
import { clearRbacContext, runWithRbacContext, setRequestActor } from "../src/rbac/context";
import { AccessPolicy } from "../src/microsoft/policy";
import { loadMicrosoftConfig } from "../src/microsoft/config";
import type { Env } from "../src/env";
import type { ElvexActor } from "../src/rbac/actor";

function memoryAuditDb() {
  const rows: Array<{ sql: string; args: unknown[] }> = [];
  return {
    rows,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              rows.push({ sql, args });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

function user(role: ElvexRole, id = `user_${role}`): ElvexActor {
  return actorFromAssignment({
    id,
    email: `${role}@elvexpropertyservices.com`,
    displayName: role,
    role,
  });
}

function expectCap(role: ElvexRole, capability: ElvexCapability, allowed: boolean) {
  const decision = can(user(role), capability);
  expect(decision.allowed, `${role} ${capability}`).toBe(allowed);
  if (!allowed) expect(decision.decision).toBe("deny");
}

describe("Elvex RBAC matrix", () => {
  it("1-7 engineer", () => {
    expectCap("engineer", "knowledge.engineer.read", true);
    expectCap("engineer", "knowledge.company.read", false);
    expectCap("engineer", "mail.info.read", false);
    expectCap("engineer", "mail.finance.read", false);
    expectCap("engineer", "xero.sales.read", false);
    expectCap("engineer", "knowledge.restricted.read", false);
    expectCap("engineer", "admin.portal.access", false);
  });

  it("8-14 office staff", () => {
    expectCap("office_staff", "knowledge.company.read", true);
    expectCap("office_staff", "mail.info.read", true);
    expectCap("office_staff", "mail.info.write", true);
    expectCap("office_staff", "mail.finance.read", false);
    expectCap("office_staff", "xero.sales.read", false);
    expectCap("office_staff", "knowledge.restricted.read", false);
    expectCap("office_staff", "admin.portal.access", false);
  });

  it("15-21 finance team", () => {
    expectCap("finance_team", "mail.info.read", true);
    expectCap("finance_team", "mail.finance.read", true);
    expectCap("finance_team", "xero.sales.read", true);
    expectCap("finance_team", "xero.finance.read", true);
    expectCap("finance_team", "xero.draft.write", false);
    expectCap("finance_team", "knowledge.restricted.read", false);
    expectCap("finance_team", "admin.portal.access", false);
  });

  it("22-28 operations manager", () => {
    expectCap("operations_manager", "mail.info.read", true);
    expectCap("operations_manager", "mail.finance.read", false);
    expectCap("operations_manager", "xero.sales.read", true);
    expectCap("operations_manager", "xero.finance.read", false);
    expectCap("operations_manager", "xero.draft.write", false);
    expectCap("operations_manager", "knowledge.restricted.read", false);
    expectCap("operations_manager", "admin.portal.access", false);
  });

  it("29-35 finance manager", () => {
    expectCap("finance_manager", "mail.info.read", true);
    expectCap("finance_manager", "mail.finance.write", true);
    expectCap("finance_manager", "xero.finance.read", true);
    expectCap("finance_manager", "xero.draft.write", true);
    expectCap("finance_manager", "knowledge.restricted.read", false);
    expectCap("finance_manager", "admin.portal.access", false);
    expectCap("finance_manager", "admin.roles.manage", false);
  });

  it("36-43 director", () => {
    expectCap("director", "mail.info.read", true);
    expectCap("director", "mail.finance.read", true);
    expectCap("director", "xero.finance.read", true);
    expectCap("director", "xero.draft.write", true);
    expectCap("director", "knowledge.restricted.read", true);
    expectCap("director", "admin.portal.access", true);
    expectCap("director", "admin.roles.manage", false);
    expectCap("director", "payment.info.access", true);
  });

  it("44-51 company admin", () => {
    expectCap("company_admin", "knowledge.engineer.read", true);
    expectCap("company_admin", "knowledge.company.read", true);
    expectCap("company_admin", "knowledge.restricted.read", true);
    expectCap("company_admin", "mail.info.write", true);
    expectCap("company_admin", "mail.finance.write", true);
    expectCap("company_admin", "xero.draft.write", true);
    expectCap("company_admin", "admin.portal.access", true);
    expectCap("company_admin", "admin.roles.manage", true);
    expectCap("company_admin", "payment.info.access", true);
  });
});

describe("security invariants", () => {
  afterEach(() => clearRbacContext());

  it("52 user-supplied role cannot escalate privileges", () => {
    const engineer = user("engineer");
    const forged = extractUntrustedRole({ role: "company_admin", actor_role: "director" });
    expect(forged).toBe("company_admin");
    const decision = can({ ...engineer, role: engineer.role }, "admin.roles.manage");
    expect(decision.allowed).toBe(false);
    expect(can(unboundActor(), "admin.roles.manage").allowed).toBe(false);
  });

  it("53 protected Microsoft users remain protected", () => {
    const policy = new AccessPolicy(
      loadMicrosoftConfig({
        EL_BUSINESS_DATA: {} as D1Database,
        EL_MS_TENANT_ID: "t",
        EL_MS_CLIENT_ID: "c",
        EL_MS_CLIENT_SECRET: "s",
      })!
    );
    policy.registerProtected({
      id: "william-id",
      displayName: "William Stone",
      mail: "william@elvexpropertyservices.com",
      userPrincipalName: "william@elvexpropertyservices.com",
      givenName: "William",
      matchedHint: "William",
      driveId: "drive-william",
    });
    expect(policy.isProtectedUser({ displayName: "William Stone" })).toBe(true);
    expect(policy.isProtectedDrive("drive-william")).toBe(true);
    expect(() => policy.assertDriveAllowed("drive-william")).toThrow(/protected user/);
  });

  it("54 generic file search cannot bypass classification", async () => {
    const items = [
      { id: "1", name: "engineer-sop.pdf", path: "/general/sop.pdf" },
      { id: "2", name: "contract of employment.pdf", path: "/hr/contract of employment.pdf" },
      { id: "3", name: "board-pack.pdf", path: "/board/pack.pdf" },
    ];
    const engineer = await filterKnowledgeItems(undefined, user("engineer"), items);
    expect(engineer.visible).toHaveLength(0);
    const office = await filterKnowledgeItems(undefined, user("office_staff"), items);
    expect(office.visible.map((i) => i.id)).toEqual(["1"]);
    const director = await filterKnowledgeItems(undefined, user("director"), items);
    expect(director.visible.map((i) => i.id).sort()).toEqual(["1", "2", "3"]);
  });

  it("55 generic email tool cannot bypass mailbox RBAC", () => {
    expect(mailboxCapabilities("info@elvexpropertyservices.com", "read")).toBe("mail.info.read");
    expect(mailboxCapabilities("finance@elvexpropertyservices.com", "write")).toBe("mail.finance.write");
    expect(mailboxCapabilities("william@elvexpropertyservices.com", "read")).toBeNull();
    expect(can(user("office_staff"), "mail.finance.read", { mailbox: "finance@elvexpropertyservices.com" }).allowed).toBe(
      false
    );
    expect(can(user("operations_manager"), "mail.finance.write").allowed).toBe(false);
  });

  it("56 generic Xero tool cannot bypass Xero RBAC", () => {
    expect(xeroCapabilityForTool("search_xero_invoices")).toBe("xero.sales.read");
    expect(xeroCapabilityForTool("analyse_xero_sales")).toBe("xero.sales.read");
    expect(xeroCapabilityForTool("analyse_xero_invoice_activity")).toBe("xero.sales.read");
    expect(xeroCapabilityForTool("analyse_xero_cash_received")).toBe("xero.sales.read");
    expect(xeroCapabilityForTool("search_xero_bills")).toBe("xero.finance.read");
    expect(xeroCapabilityForTool("get_xero_report", { report: "profitandloss" })).toBe("xero.finance.read");
    expect(xeroCapabilityForTool("get_xero_report", { report: "agedreceivables" })).toBe("xero.sales.read");
    expect(xeroCapabilityForTool("create_xero_draft_invoice")).toBe("xero.draft.write");
    expect(xeroCapabilityForTool("unregistered_xero_export")).toBeNull();
    expect(can(user("operations_manager"), "xero.finance.read").allowed).toBe(false);
    expect(can(user("finance_team"), "xero.draft.write").allowed).toBe(false);
  });

  it("57 unauthenticated privileged request fails closed", () => {
    expect(can(null, "mail.finance.read").allowed).toBe(false);
    expect(can(unboundActor(), "xero.sales.read").allowed).toBe(false);
    expect(can(unboundActor(), "knowledge.restricted.read").reason).toMatch(/identity/i);
  });

  it("58 role change requires company_admin and is not self-service", async () => {
    expect(can(user("director"), "admin.roles.manage").allowed).toBe(false);
    expect(can(user("company_admin"), "admin.roles.manage").allowed).toBe(true);
    const self = user("company_admin", "self");
    expect(self.actorId).toBe("self");
    const db = memoryAuditDb();
    const decision = can(user("company_admin"), "admin.roles.manage", { resource: "user_2" });
    await recordPermissionAudit(db as unknown as D1Database, decision, {
      eventType: "role.changed",
      force: true,
      correlationId: "corr_role",
    });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].args).toContain("admin.roles.manage");
    expect(JSON.stringify(db.rows[0].args)).toContain("role.changed");
  });

  it("59 denied sensitive request creates an audit event", async () => {
    const decision = can(user("office_staff"), "mail.finance.read", { mailbox: "finance@elvexpropertyservices.com" });
    expect(decision.allowed).toBe(false);
    expect(decision.capability).toBe("mail.finance.read");
    expect(decision.resource).toBe("finance@elvexpropertyservices.com");
    expect(decision.decision).toBe("deny");
    const db = memoryAuditDb();
    await recordPermissionAudit(db as unknown as D1Database, decision, { correlationId: "corr_deny" });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].args).toContain("deny");
    expect(db.rows[0].args).toContain("mail.finance.read");
    expect(db.rows[0].args).toContain("corr_deny");
  });

  it("signed INFRA user sync cannot be forged by changing the role after signing", async () => {
    const signed = await signUserSync("sync-secret", {
      externalId: "user_1",
      email: "engineer@elvexpropertyservices.com",
      role: "engineer",
    });
    const env = { EL_RBAC_IDENTITY_SECRET: "sync-secret" } as Env;
    expect((await verifyUserSync(env, signed))?.role).toBe("engineer");
    expect(
      await verifyUserSync(env, { ...signed, role: "company_admin" })
    ).toBeNull();
    expect(await verifyUserSync({} as Env, signed)).toBeNull();
  });

  it("deny beats allow and unknown capability fails closed", () => {
    expect(can(user("company_admin"), "not.a.capability").allowed).toBe(false);
    expect(can({ ...user("engineer"), role: "not_a_role" as ElvexRole }, "knowledge.engineer.read").allowed).toBe(false);
  });

  it("service principals do not inherit company_admin", () => {
    const automation: ElvexActor = {
      principalType: "service",
      actorId: "svc_daily_sales",
      email: null,
      displayName: "Daily Sales",
      role: null,
      serviceCapabilities: ["xero.sales.read"],
      identityBound: true,
      identitySource: "d1",
      companyId: "co_el",
      correlationId: "corr_1",
    };
    expect(can(automation, "xero.sales.read").allowed).toBe(true);
    expect(can(automation, "xero.finance.read").allowed).toBe(false);
    expect(can(automation, "admin.roles.manage").allowed).toBe(false);
  });

  it("signed identity headers never include a grantable role", async () => {
    const headers = await signIdentityHeaders("test-secret", {
      actorId: "user_1",
      email: "engineer@elvexpropertyservices.com",
      principalType: "user",
    });
    expect(JSON.stringify(headers)).not.toMatch(/company_admin/);
    expect(headers["x-elvex-actor-id"]).toBe("user_1");
  });

  it("request context uses injected actor, not tool arguments", async () => {
    const env = { EL_BUSINESS_DATA: {} as D1Database } as Env;
    await runWithRbacContext(env, null, () => {
      setRequestActor(user("engineer"));
      expect(can(user("engineer"), "xero.sales.read").allowed).toBe(false);
    });
  });

  it("operations manager does not inherit finance mailbox or P&L", () => {
    expectCap("operations_manager", "mail.finance.read", false);
    expectCap("operations_manager", "xero.finance.read", false);
    expectCap("operations_manager", "xero.settings.read", false);
  });

  it("finance information does not imply restricted management", () => {
    expectCap("finance_team", "knowledge.finance.read", true);
    expectCap("finance_team", "knowledge.restricted.read", false);
    expectCap("finance_manager", "knowledge.restricted.read", false);
  });

  it("finance manager does not receive payment-information admin", () => {
    expectCap("finance_manager", "payment.info.access", false);
    expectCap("director", "payment.info.access", true);
  });

  it("every canonical role is explicit", () => {
    expect(ELVEX_ROLES).toEqual([
      "engineer",
      "office_staff",
      "finance_team",
      "operations_manager",
      "finance_manager",
      "director",
      "company_admin",
    ]);
  });
});
