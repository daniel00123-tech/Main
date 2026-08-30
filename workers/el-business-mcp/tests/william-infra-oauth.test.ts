import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { can } from "../src/rbac/authorize";
import { resolveActor } from "../src/rbac/identity";
import { updateUserRole, updateUserStatus, upsertCompanyUser } from "../src/rbac/store";
import { issueMcpAccessToken } from "../src/oauth/jwt";
import { inferConnectorFromTool, reportInfraMcpUsage, usageSuccessFromMcpResponse } from "../src/infra/usage";
import { createMemoryD1 } from "./helpers/memory-d1";
import { DEFAULT_PROTECTED_USER_HINTS } from "../src/microsoft/config";
import { organisationMatchesExpected } from "../src/xero/config";

const WILLIAM_ID = "user_william";
const WILLIAM_EMAIL = "william@elvexpropertyservices.com";
const ORIGIN = "https://el-business-mcp.infrastack.app";
const TOKEN_SECRET = "test-mcp-token-secret-not-for-production";

function env(overrides: Partial<Env> = {}): Env {
  return {
    EL_BUSINESS_DATA: createMemoryD1(),
    MCP_AUTH_TOKEN: "shared-service-token",
    EL_ADMIN_TOKEN: "admin-token",
    EL_RBAC_IDENTITY_SECRET: TOKEN_SECRET,
    EL_MCP_TOKEN_SECRET: TOKEN_SECRET,
    EL_MCP_PUBLIC_ORIGIN: ORIGIN,
    EL_XERO_EXPECTED_ORG: "Elvex Property Services Ltd",
    ...overrides,
  };
}

async function williamToken(testEnv: Env, extra: Record<string, string> = {}) {
  const issued = await issueMcpAccessToken(testEnv, {
    userId: WILLIAM_ID,
    companyId: extra.companyId ?? "co_el",
    companySlug: extra.companySlug ?? "el-business",
    client: extra.client ?? "chatgpt",
    email: WILLIAM_EMAIL,
    name: "William Stone",
  });
  if (!issued) throw new Error("failed to issue William token");
  return issued;
}

describe("William INFRA office_staff end-to-end", () => {
  it("connects without Microsoft auth and receives an INFRA-backed MCP session for EL Business", async () => {
    const testEnv = env();
    await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      externalId: WILLIAM_ID,
      email: WILLIAM_EMAIL,
      displayName: "William Stone",
      role: "office_staff",
    });
    const issued = await williamToken(testEnv);
    expect(issued.claims.sub).toBe(WILLIAM_ID);
    expect(issued.claims.company_id).toBe("co_el");
    expect(issued.claims.company_slug).toBe("el-business");
    expect(issued.claims.client).toBe("chatgpt");
    expect(issued.claims.typ).toBe("infra_mcp_access");
    expect("role" in issued.claims).toBe(false);

    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${issued.accessToken}` } })
    );
    expect(actor.identityBound).toBe(true);
    expect(actor.identitySource).toBe("infra_oauth");
    expect(actor.role).toBe("office_staff");
    expect(actor.companyId).toBe("co_el");
    expect(actor.microsoftOid ?? null).toBeNull();
  });

  it("Office Staff permitted knowledge and info@ work; finance, Xero, and admin are denied", async () => {
    const testEnv = env();
    await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      externalId: WILLIAM_ID,
      email: WILLIAM_EMAIL,
      role: "office_staff",
    });
    const { accessToken } = await williamToken(testEnv);
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${accessToken}` } })
    );
    expect(can(actor, "knowledge.engineer.read").allowed).toBe(true);
    expect(can(actor, "knowledge.company.read").allowed).toBe(true);
    expect(can(actor, "mail.info.read").allowed).toBe(true);
    expect(can(actor, "mail.info.write").allowed).toBe(true);
    expect(can(actor, "mail.finance.read").allowed).toBe(false);
    expect(can(actor, "mail.finance.write").allowed).toBe(false);
    expect(can(actor, "xero.sales.read").allowed).toBe(false);
    expect(can(actor, "xero.finance.read").allowed).toBe(false);
    expect(can(actor, "admin.portal.access").allowed).toBe(false);
    expect(can(actor, "admin.roles.manage").allowed).toBe(false);
  });

  it("spoofing another user, company, or role is denied", async () => {
    const testEnv = env();
    await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      externalId: WILLIAM_ID,
      email: WILLIAM_EMAIL,
      role: "office_staff",
    });
    const otherCompany = await williamToken(testEnv, { companyId: "co_ht", companySlug: "ht-business" });
    const spoofedCompany = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${otherCompany.accessToken}` } })
    );
    expect(spoofedCompany.identityBound).toBe(false);

    const { accessToken } = await williamToken(testEnv);
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "company_admin", actor_id: "user_ella" }),
      })
    );
    expect(actor.actorId).toBe(WILLIAM_ID);
    expect(actor.role).toBe("office_staff");
    expect(can(actor, "admin.roles.manage").allowed).toBe(false);
  });

  it("changing William's INFRA role affects subsequent calls without reconnecting", async () => {
    const testEnv = env();
    const user = await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      externalId: WILLIAM_ID,
      email: WILLIAM_EMAIL,
      role: "office_staff",
    });
    const { accessToken } = await williamToken(testEnv);
    await updateUserRole(testEnv.EL_BUSINESS_DATA, user.id, "finance_team");
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${accessToken}` } })
    );
    expect(actor.role).toBe("finance_team");
    expect(can(actor, "xero.sales.read").allowed).toBe(true);
    expect(can(actor, "mail.finance.read").allowed).toBe(true);
  });

  it("disabling William immediately denies subsequent calls", async () => {
    const testEnv = env();
    const user = await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      externalId: WILLIAM_ID,
      email: WILLIAM_EMAIL,
      role: "office_staff",
    });
    const { accessToken } = await williamToken(testEnv);
    await updateUserStatus(testEnv.EL_BUSINESS_DATA, user.id, "disabled");
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${accessToken}` } })
    );
    expect(actor.identityBound).toBe(false);
    expect(can(actor, "knowledge.company.read").allowed).toBe(false);
  });

  it("shared MCP bearer token cannot impersonate William", async () => {
    const testEnv = env();
    await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      externalId: WILLIAM_ID,
      email: WILLIAM_EMAIL,
      role: "office_staff",
    });
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: "Bearer shared-service-token" } })
    );
    expect(actor.identitySource).toBe("service_token");
    expect(actor.identityBound).toBe(false);
    expect(actor.actorId).not.toBe(WILLIAM_ID);
    expect(can(actor, "knowledge.company.read").allowed).toBe(false);
  });

  it("usage is attributed to William + EL Business + ChatGPT without logging payloads", async () => {
    const testEnv = env();
    await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      externalId: WILLIAM_ID,
      email: WILLIAM_EMAIL,
      role: "office_staff",
    });
    const { accessToken } = await williamToken(testEnv);
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${accessToken}` } })
    );
    testEnv.INFRA_PUBLIC_API_URL = "https://infra-api.example.test";
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/internal/mcp/usage")) {
        calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(JSON.stringify({ ok: true, usageId: "usage_1" }), { status: 200 });
      }
      return original(input as Request, init);
    }) as typeof fetch;
    try {
      const result = await reportInfraMcpUsage(testEnv, {
        actor,
        toolName: "search_company_knowledge",
        success: true,
        durationMs: 12,
        correlationId: "corr_william_1",
        client: "chatgpt",
      });
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toMatchObject({
        companyId: "co_el",
        companySlug: "el-business",
        userId: WILLIAM_ID,
        actorEmail: WILLIAM_EMAIL,
        sourceClient: "chatgpt",
        toolName: "search_company_knowledge",
        connector: "knowledge",
        success: true,
        correlationId: "corr_william_1",
      });
      expect(JSON.stringify(calls[0].body)).not.toMatch(/prompt|email body|document/i);
    } finally {
      globalThis.fetch = original;
    }
    expect(inferConnectorFromTool("analyse_xero_sales")).toBe("xero");
    expect(inferConnectorFromTool("list_info_mailbox")).toBe("microsoft");
    expect(usageSuccessFromMcpResponse(200, { result: { isError: true } })).toBe(false);
    expect(usageSuccessFromMcpResponse(200, { result: { content: [] } })).toBe(true);
  });

  it("Microsoft protected users and Xero org lock remain intact", () => {
    expect(DEFAULT_PROTECTED_USER_HINTS).toEqual(expect.arrayContaining(["William", "Ella"]));
    expect(organisationMatchesExpected("Elvex Property Services Ltd", "Elvex Property Services Ltd")).toBe(true);
  });
});
