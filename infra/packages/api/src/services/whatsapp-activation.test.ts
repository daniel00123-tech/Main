import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE } from "./phone";
import {
  INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
  INFRA_WHATSAPP_PHONE_NUMBER_ID,
  inboundSignatureRequired,
  inspectWhatsAppAssets,
  secretPresence,
} from "./whatsapp-assets";
import { compactConversationPrompt } from "./whatsapp-context";
import { formatWhatsAppReply } from "./whatsapp-format";
import {
  looksLikeWriteIntent,
  parseCompanySelection,
  resolveWhatsAppCompany,
  WHATSAPP_AI_MODEL,
  WHATSAPP_AI_PROVIDER,
} from "./whatsapp-orchestrator";

const { executeGatewayRequest, sendWhatsAppTextMock, getUserByMobileE164, toSessionUser, recordUsageEvent, scheduleQualityAudit } =
  vi.hoisted(() => ({
    executeGatewayRequest: vi.fn(),
    sendWhatsAppTextMock: vi.fn(),
    getUserByMobileE164: vi.fn(),
    toSessionUser: vi.fn(),
    recordUsageEvent: vi.fn(),
    scheduleQualityAudit: vi.fn(),
  }));

vi.mock("./gateway", () => ({ executeGatewayRequest }));
vi.mock("./whatsapp-send", async () => {
  const actual = await vi.importActual<typeof import("./whatsapp-send")>("./whatsapp-send");
  return {
    ...actual,
    sendWhatsAppText: sendWhatsAppTextMock,
    sendWhatsAppInteractiveButtons: vi.fn().mockResolvedValue({
      ok: false,
      kind: "customer_service_reply",
      error: "interactive_fallback",
      retryable: false,
      attempts: 1,
    }),
    sendWhatsAppInteractiveList: vi.fn().mockResolvedValue({
      ok: false,
      kind: "customer_service_reply",
      error: "interactive_fallback",
      retryable: false,
      attempts: 1,
    }),
    sendWhatsAppTypingIndicator: vi.fn().mockResolvedValue({ ok: true, supported: true }),
  };
});
vi.mock("../auth/users", () => ({ getUserByMobileE164, toSessionUser }));
vi.mock("./usage", () => ({ recordUsageEvent }));
vi.mock("./quality-auditor", () => ({ scheduleQualityAudit }));

import { handleWhatsAppInboundMessage } from "./whatsapp-orchestrator";
import { persistWhatsAppInboundEvent, verifyWhatsAppSignature } from "./whatsapp-webhook";

const SECRET = "meta-app-secret-for-tests-only";
const TOKEN = "EAAG-test-token-not-real";

function env(overrides: Partial<Env> = {}): Env {
  const store = new Map<string, Record<string, unknown>>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM users") && sql.includes("status = 'active'")) {
                if (String(args[0]).includes("900123")) {
                  return {
                    id: "user_1",
                    email: "sam@example.com",
                    display_name: "Sam",
                    status: "active",
                    mobile_e164: "+447700900123",
                    mobile_verified: 1,
                    mobile_verification_required: 0,
                  };
                }
                return null;
              }
              if (sql.includes("FROM whatsapp_conversations")) {
                return store.get(`conv:${args[0]}`) ?? null;
              }
              if (sql.includes("FROM whatsapp_inbound_events") && sql.includes("wamid")) {
                return store.get(`wamid:${args[0]}`) ?? null;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM company_memberships")) {
                const multi = store.get("multi")?.on;
                if (multi) {
                  return {
                    results: [
                      { company_id: "co_a", role: "admin", status: "active", company_name: "Alpha", company_slug: "alpha" },
                      { company_id: "co_b", role: "admin", status: "active", company_name: "Beta", company_slug: "beta" },
                    ],
                  };
                }
                return {
                  results: [
                    { company_id: "co_a", role: "admin", status: "active", company_name: "Alpha", company_slug: "alpha" },
                  ],
                };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO whatsapp_conversations")) {
                store.set(`conv:${args[0]}`, {
                  user_id: args[0],
                  company_id: args[1],
                  pending_company_selection: args[2],
                  turns_json: args[3],
                  entities_json: args[4],
                  updated_at: args[5] ?? args[4],
                });
              }
              if (sql.includes("INSERT INTO whatsapp_inbound_events") && args[1]) {
                store.set(`wamid:${args[1]}`, { id: args[0], wamid: args[1] });
              }
              return { success: true };
            },
          };
        },
        async run() {
          return { success: true };
        },
      };
    },
  } as unknown as D1Database;

  return {
    DB: db,
    ENVIRONMENT: "test",
    SESSION_SECRET: "test",
    ALLOWED_ORIGINS: "http://localhost:5173",
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-token-for-tests-32chars-min",
    WHATSAPP_PHONE_NUMBER_ID: INFRA_WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_BUSINESS_ACCOUNT_ID: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
    WHATSAPP_ACCESS_TOKEN: TOKEN,
    META_APP_SECRET: SECRET,
    WHATSAPP_OUTBOUND_AI_ENABLED: "true",
    ...overrides,
  } as Env;
}

function inbound(overrides: Partial<Parameters<typeof handleWhatsAppInboundMessage>[1]> = {}) {
  return {
    wamid: overrides.wamid ?? `wamid.${Math.random().toString(16).slice(2)}`,
    from: overrides.from ?? "447700900123",
    type: overrides.type ?? "text",
    text: overrides.text ?? "Find the Coal Search document and tell me what it relates to.",
    phoneNumberId: overrides.phoneNumberId ?? INFRA_WHATSAPP_PHONE_NUMBER_ID,
    businessAccountId: overrides.businessAccountId ?? INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
    timestamp: overrides.timestamp ?? "1710000000",
  };
}

describe("WhatsApp production assets", () => {
  it("accepts the real Infra phone and WABA IDs", () => {
    const check = inspectWhatsAppAssets(env());
    expect(check.ok).toBe(true);
    expect(check.looksLikeSandbox).toBe(false);
    expect(check.phoneMatchesProduction).toBe(true);
    expect(check.wabaMatchesProduction).toBe(true);
  });

  it("fails closed on Meta sandbox-looking IDs", () => {
    const check = inspectWhatsAppAssets(
      env({
        WHATSAPP_PHONE_NUMBER_ID: "15550000000",
        WHATSAPP_BUSINESS_ACCOUNT_ID: "5551111111",
      }),
    );
    expect(check.ok).toBe(false);
    expect(check.looksLikeSandbox).toBe(true);
  });

  it("reports secret presence without values", () => {
    const presence = secretPresence(env());
    expect(presence).toEqual({
      verifyToken: true,
      accessToken: true,
      appSecret: true,
      registrationPin: false,
    });
    expect(JSON.stringify(presence)).not.toContain(TOKEN);
    expect(JSON.stringify(presence)).not.toContain(SECRET);
  });
});

describe("WhatsApp signature and send safety", () => {
  it("accepts a valid signed body and rejects a bad one", async () => {
    const body = '{"object":"whatsapp_business_account"}';
    const digest = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
    expect(await verifyWhatsAppSignature(env(), body, `sha256=${digest}`)).toEqual({
      configured: true,
      valid: true,
    });
    expect(await verifyWhatsAppSignature(env(), body, "sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toEqual({
      configured: true,
      valid: false,
    });
    expect(inboundSignatureRequired(env({ ENVIRONMENT: "production", META_APP_SECRET: "" }))).toBe(true);
  });

});

describe("WhatsApp identity, context, and formatting", () => {
  it("keeps company selection deterministic and asks when ambiguous", () => {
    const companies = [
      { companyId: "co_a", companyName: "Alpha" },
      { companyId: "co_b", companyName: "Beta" },
    ];
    expect(resolveWhatsAppCompany({ memberships: companies, lastCompanyId: "co_b", pendingSelection: false, message: "hi" })).toEqual({
      status: "resolved",
      companyId: "co_b",
      companyName: "Beta",
    });
    expect(resolveWhatsAppCompany({ memberships: companies, lastCompanyId: null, pendingSelection: false, message: "hi" }).status).toBe(
      "select",
    );
    expect(parseCompanySelection("2", companies)?.companyId).toBe("co_b");
  });

  it("blocks write-looking prompts and keeps follow-up context compact and tenant-bound", () => {
    expect(looksLikeWriteIntent("create an invoice for Acme")).toBe(true);
    expect(looksLikeWriteIntent("What were sales this month?")).toBe(false);
    const prompt = compactConversationPrompt(
      [
        { role: "user", text: "What were sales this month?" },
        { role: "assistant", text: "About 12k" },
      ],
      "And last month?",
    );
    expect(prompt).toContain("And last month?");
    expect(prompt).toContain("same company only");
  });

  it("formats mobile replies without tables, JSON, or IDs", () => {
    const formatted = formatWhatsAppReply(
      "Title\n\n| a | b |\n| --- | --- |\n\n```json\n{\"id\":\"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\"}\n```\nUseful sentence.",
    );
    expect(formatted).not.toMatch(/\| a \|/);
    expect(formatted).not.toMatch(/aaaaaaaa-bbbb-4ccc/);
    expect(formatted).not.toMatch(/\{"id"/);
  });
});

describe("WhatsApp inbound orchestration", () => {
  beforeEach(() => {
    executeGatewayRequest.mockReset();
    sendWhatsAppTextMock.mockReset();
    getUserByMobileE164.mockReset();
    toSessionUser.mockReset();
    recordUsageEvent.mockReset().mockResolvedValue({ id: "usage_1" });
    sendWhatsAppTextMock.mockResolvedValue({ ok: true, kind: "customer_service_reply", messageId: "wamid.OUT", attempts: 1 });
    getUserByMobileE164.mockResolvedValue({
      id: "user_1",
      email: "sam@example.com",
      displayName: "Sam",
      status: "active",
    });
    toSessionUser.mockResolvedValue({
      userId: "user_1",
      email: "sam@example.com",
      displayName: "Sam",
      isPlatformAdmin: false,
      memberships: [{ companyId: "co_a", role: "admin", customRoleId: null, teamId: null }],
      credentialsVersion: 1,
    });
  });

  it("sends only the public message for unknown numbers", async () => {
    const result = await handleWhatsAppInboundMessage(env(), inbound({ from: "447700900999", text: "hello" }));
    expect(result.outcome).toBe("unknown");
    expect(result.publicReply).toBe(UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE);
    expect(result.companyId).toBeNull();
    expect(executeGatewayRequest).not.toHaveBeenCalled();
    expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE, inCustomerServiceWindow: true }),
    );
  });

  it("asks a multi-company user to choose before accessing data", async () => {
    const runtime = env();
    (runtime as { DB: D1Database } & { __multi?: boolean });
    const db = runtime.DB as unknown as { prepare: (sql: string) => ReturnType<D1Database["prepare"]> };
    const original = db.prepare.bind(db);
    runtime.DB.prepare = ((sql: string) => {
      const stmt = original(sql);
      if (sql.includes("FROM company_memberships")) {
        return {
          bind() {
            return {
              async all() {
                return {
                  results: [
                    { company_id: "co_a", role: "admin", status: "active", company_name: "Alpha", company_slug: "alpha" },
                    { company_id: "co_b", role: "admin", status: "active", company_name: "Beta", company_slug: "beta" },
                  ],
                };
              },
              async first() {
                return null;
              },
              async run() {
                return { success: true };
              },
            };
          },
        } as ReturnType<D1Database["prepare"]>;
      }
      return stmt;
    }) as D1Database["prepare"];

    const result = await handleWhatsAppInboundMessage(runtime, inbound({ text: "What were sales this month?" }));
    expect(result.outcome).toBe("company_selection");
    expect(result.publicReply).toMatch(/Which company would you like me to use/i);
    expect(executeGatewayRequest).not.toHaveBeenCalled();
  });

  it("runs a read query through the existing gateway and records usage", async () => {
    executeGatewayRequest.mockResolvedValue({
      status: 200,
      result: {
        results: [{ id: "doc_coal", title: "Coal Search", snippet: "It relates to a mineral rights search." }],
      },
    });
    const waitUntil = vi.fn();
    const result = await handleWhatsAppInboundMessage(
      env(),
      inbound({ text: "Find the Coal Search document and tell me what it relates to." }),
      { signatureValid: true, waitUntil },
    );
    expect(result.outcome).toBe("answered");
    expect(result.companyId).toBe("co_a");
    expect(executeGatewayRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "co_a",
        sourceClient: "whatsapp",
        toolName: "search_company_knowledge",
        waitUntil,
      }),
    );
    expect(result.publicReply).toMatch(/Coal Search|mineral/i);
    expect(recordUsageEvent).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(WHATSAPP_AI_PROVIDER).toBe("infra-gateway");
    expect(WHATSAPP_AI_MODEL).toBe("company-mcp-knowledge");
  });

  it("does not call tools for a write-looking request", async () => {
    const result = await handleWhatsAppInboundMessage(env(), inbound({ text: "create an invoice for Acme" }));
    expect(result.outcome).toBe("write_blocked");
    expect(executeGatewayRequest).not.toHaveBeenCalled();
  });

  it("returns a safe tool-failure reply", async () => {
    executeGatewayRequest.mockResolvedValue({ status: 403, error: "Permission denied" });
    const result = await handleWhatsAppInboundMessage(env(), inbound({ text: "What can you tell me about the documents?" }));
    expect(result.outcome).toBe("tool_failed");
    expect(result.publicReply).not.toMatch(/Permission denied|co_a|token/i);
  });

  it("returns a safe AI-failure reply", async () => {
    executeGatewayRequest.mockRejectedValue(new Error("model exploded EAAG-test-token-not-real"));
    const result = await handleWhatsAppInboundMessage(env(), inbound({ text: "Find the rental document" }));
    expect(result.outcome).toBe("ai_failed");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("skips a duplicate wamid", async () => {
    const runtime = env();
    const first = inbound({ wamid: "wamid.DUP" });
    executeGatewayRequest.mockResolvedValue({ status: 200, result: { results: [] } });
    await handleWhatsAppInboundMessage(runtime, first);
    const rows = new Map<string, { id: string }>([["wamid.DUP", { id: "wa_evt_1" }]]);
    runtime.DB.prepare = ((sql: string) => {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("wamid") && sql.includes("processed = 1")) {
                return rows.get(String(args[0])) ?? null;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return { success: true };
            },
          };
        },
        async run() {
          return { success: true };
        },
      };
    }) as D1Database["prepare"];
    const second = await handleWhatsAppInboundMessage(runtime, inbound({ wamid: "wamid.DUP", text: "again" }));
    expect(second.duplicate).toBe(true);
  });

  it("keeps persist idempotent for the same inbound wamid", async () => {
    const seen = new Map<string, string>();
    const runtime = env();
    runtime.DB.prepare = ((sql: string) => {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("wamid")) return seen.has(String(args[0])) ? { id: seen.get(String(args[0])) } : null;
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO whatsapp_inbound_events") && args[1]) {
                seen.set(String(args[1]), String(args[0]));
              }
              return { success: true };
            },
          };
        },
        async run() {
          return { success: true };
        },
      };
    }) as D1Database["prepare"];
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: INFRA_WHATSAPP_PHONE_NUMBER_ID },
                messages: [{ id: "wamid.IDEMP", from: "447700900123", type: "text", text: { body: "hi" } }],
              },
            },
          ],
        },
      ],
    });
    const first = await persistWhatsAppInboundEvent(runtime, { rawBody: body, signatureValid: true, signatureConfigured: true });
    const second = await persistWhatsAppInboundEvent(runtime, { rawBody: body, signatureValid: true, signatureConfigured: true });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
  });
});
