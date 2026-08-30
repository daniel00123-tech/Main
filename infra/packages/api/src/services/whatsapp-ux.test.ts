import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../env";
import { UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE } from "./phone";
import { INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID, INFRA_WHATSAPP_PHONE_NUMBER_ID } from "./whatsapp-assets";
import { capabilityReplyForCompany, formatCapabilityReply } from "./whatsapp-capabilities";
import { acknowledgementMessage, conversationalReply, progressMessage, STILL_WORKING_MESSAGE } from "./whatsapp-conversation";
import { classifyWhatsAppIntent, needsToolWork, softenSearchQuery } from "./whatsapp-intent";
import { createWhatsAppLatencyMarks, summariseWhatsAppLatency } from "./whatsapp-latency";
import { detectQualitySignals } from "./quality-auditor";
import { searchQueryFromContext } from "./whatsapp-context";

const { executeGatewayRequest, sendWhatsAppTextMock, getUserByMobileE164, toSessionUser, recordUsageEvent } = vi.hoisted(
  () => ({
    executeGatewayRequest: vi.fn(),
    sendWhatsAppTextMock: vi.fn(),
    getUserByMobileE164: vi.fn(),
    toSessionUser: vi.fn(),
    recordUsageEvent: vi.fn(),
  }),
);

vi.mock("./gateway", () => ({ executeGatewayRequest }));
vi.mock("./whatsapp-send", async () => {
  const actual = await vi.importActual<typeof import("./whatsapp-send")>("./whatsapp-send");
  return {
    ...actual,
    sendWhatsAppText: sendWhatsAppTextMock,
    sendWhatsAppTypingIndicator: vi.fn().mockResolvedValue({ ok: true, supported: true }),
  };
});
vi.mock("../auth/users", () => ({ getUserByMobileE164, toSessionUser }));
vi.mock("./usage", () => ({ recordUsageEvent }));
vi.mock("./quality-auditor", async () => {
  const actual = await vi.importActual<typeof import("./quality-auditor")>("./quality-auditor");
  return { ...actual, scheduleQualityAudit: vi.fn() };
});

import { handleWhatsAppInboundMessage } from "./whatsapp-orchestrator";

function env(): Env {
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
              return null;
            },
            async all() {
              if (sql.includes("FROM company_memberships")) {
                return {
                  results: [
                    { company_id: "co_a", role: "admin", status: "active", company_name: "Alpha", company_slug: "alpha" },
                  ],
                };
              }
              if (sql.includes("FROM connector_instances")) {
                return {
                  results: [
                    { connector_definition_id: "conn_microsoft_365", name: "M365", status: "healthy", auth_status: "connected" },
                    { connector_definition_id: "conn_xero", name: "Xero", status: "healthy", auth_status: "connected" },
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
                  updated_at: args[4],
                });
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
  return {
    DB: db,
    ENVIRONMENT: "test",
    SESSION_SECRET: "test",
    ALLOWED_ORIGINS: "http://localhost:5173",
    WHATSAPP_PHONE_NUMBER_ID: INFRA_WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_BUSINESS_ACCOUNT_ID: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
    WHATSAPP_ACCESS_TOKEN: "EAAG-test-token-not-real",
    META_APP_SECRET: "meta-app-secret-for-tests-only",
    WHATSAPP_OUTBOUND_AI_ENABLED: "true",
  } as Env;
}

function inbound(text: string) {
  return {
    wamid: `wamid.${Math.random().toString(16).slice(2)}`,
    from: "447700900123",
    type: "text",
    text,
    phoneNumberId: INFRA_WHATSAPP_PHONE_NUMBER_ID,
    businessAccountId: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
    timestamp: "1710000000",
  };
}

describe("WhatsApp intent and typo handling", () => {
  it("classifies greetings, thanks, help and writes without tools", () => {
    expect(classifyWhatsAppIntent("Hi")).toBe("greeting");
    expect(classifyWhatsAppIntent("Hello")).toBe("greeting");
    expect(classifyWhatsAppIntent("How are you?")).toBe("casual");
    expect(classifyWhatsAppIntent("Thanks")).toBe("thanks");
    expect(classifyWhatsAppIntent("What can you do?")).toBe("capabilities");
    expect(classifyWhatsAppIntent("Can you price jobs up?")).toBe("capabilities");
    expect(classifyWhatsAppIntent("Can you find the Coal Search document")).toBe("knowledge_search");
    expect(classifyWhatsAppIntent("create an invoice")).toBe("write_action");
    expect(classifyWhatsAppIntent("summarise that", { hasPriorTurns: true })).toBe("clarification");
    expect(classifyWhatsAppIntent("find cold serch doc", { hasPriorTurns: true })).toBe("knowledge_search");
    expect(classifyWhatsAppIntent("What about the rental information in Arnold Crescent?", { hasPriorTurns: true })).toBe(
      "knowledge_search",
    );
    expect(needsToolWork(classifyWhatsAppIntent("find coal search doc"))).toBe(true);
    expect(needsToolWork(classifyWhatsAppIntent("hi"))).toBe(false);
  });

  it("softens ordinary search typos without inventing write actions", () => {
    expect(softenSearchQuery("find cold serch doc")).toMatch(/coal search/i);
    expect(softenSearchQuery("create an invoice")).toBe("create an invoice");
  });
});

describe("WhatsApp conversation and capabilities", () => {
  it("answers greetings locally with Infra identity", () => {
    expect(conversationalReply("greeting", { text: "Hi" })).toMatch(/Infra/i);
    expect(conversationalReply("casual", { text: "How are you?" })).toMatch(/help/i);
    expect(acknowledgementMessage("a")).not.toBe(acknowledgementMessage("bbbb"));
  });

  it("describes only connected systems", () => {
    expect(formatCapabilityReply(["company emails, OneDrive and SharePoint", "permitted Xero information"])).toMatch(
      /Xero|emails/i,
    );
    expect(formatCapabilityReply([])).not.toMatch(/BigChange|Commusoft/i);
  });
});

describe("WhatsApp latency marks", () => {
  it("computes acknowledgement and total latency", () => {
    const marks = createWhatsAppLatencyMarks(1_000);
    marks.webhookReceivedAt = 1_000;
    marks.acknowledgementSentAt = 2_200;
    const report = summariseWhatsAppLatency(marks, 8_000);
    expect(report.acknowledgementMs).toBe(1_200);
    expect(report.totalMs).toBe(7_000);
  });
});

describe("WhatsApp UX orchestration", () => {
  beforeEach(() => {
    executeGatewayRequest.mockReset();
    sendWhatsAppTextMock.mockReset().mockResolvedValue({
      ok: true,
      kind: "customer_service_reply",
      messageId: "wamid.OUT",
      attempts: 1,
    });
    recordUsageEvent.mockReset().mockResolvedValue({ id: "usage_1" });
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

  it.each(["Hi", "Hello", "How are you?", "Thanks", "What can you do?"])(
    "handles %s without MCP",
    async (text) => {
      const result = await handleWhatsAppInboundMessage(env(), inbound(text));
      expect(result.outcome).toBe("answered");
      expect(executeGatewayRequest).not.toHaveBeenCalled();
      expect(sendWhatsAppTextMock).toHaveBeenCalledTimes(1);
      expect(result.acknowledgementSent).not.toBe(true);
    },
  );

  it("acks a knowledge query then answers without duplicate ack", async () => {
    executeGatewayRequest.mockResolvedValue({
      status: 200,
      result: { results: [{ id: "doc_coal", title: "Coal Search", snippet: "Mineral rights search." }] },
    });
    const result = await handleWhatsAppInboundMessage(env(), inbound("Find the Coal Search document"));
    expect(result.acknowledgementSent).toBe(true);
    expect(sendWhatsAppTextMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    const bodies = sendWhatsAppTextMock.mock.calls.map((call) => call[1]?.body as string);
    expect(bodies.some((body) => /checking|looking|On it/i.test(body))).toBe(true);
    expect(bodies.filter((body) => /checking|looking|On it/i.test(body))).toHaveLength(1);
    expect(result.publicReply).toMatch(/Coal Search|Mineral/i);
  });

  it("softens a typo search before the gateway", async () => {
    executeGatewayRequest.mockResolvedValue({ status: 200, result: { results: [] } });
    await handleWhatsAppInboundMessage(env(), inbound("find cold serch doc"));
    const args = executeGatewayRequest.mock.calls[0]?.[1] as { arguments?: { query?: string } };
    expect(String(args?.arguments?.query ?? "")).toMatch(/coal search/i);
  });

  it("keeps follow-up context on the same company", () => {
    const prompt = searchQueryFromContext(
      [
        { role: "user", text: "What were sales this month?" },
        { role: "assistant", text: "About 12k" },
      ],
      "What about last month?",
      true,
    );
    expect(prompt).toContain("last month");
    expect(prompt).toContain("sales this month");
    expect(searchQueryFromContext([{ role: "user", text: "Hi" }], "Find the Coal Search document", false)).toBe(
      "Find the Coal Search document",
    );
  });

  it("sends only the unknown-number message", async () => {
    const result = await handleWhatsAppInboundMessage(env(), {
      ...inbound("Hi"),
      from: "447700900999",
    });
    expect(result.publicReply).toBe(UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE);
    expect(executeGatewayRequest).not.toHaveBeenCalled();
  });

  it("keeps writes on the approval path", async () => {
    const result = await handleWhatsAppInboundMessage(env(), inbound("Send this invoice"));
    expect(result.outcome).toBe("write_blocked");
    expect(executeGatewayRequest).not.toHaveBeenCalled();
  });

  it("uses a permission-safe error", async () => {
    executeGatewayRequest.mockResolvedValue({ status: 403, error: "Permission denied MCP-123" });
    const result = await handleWhatsAppInboundMessage(env(), inbound("Find the Coal Search document"));
    expect(result.publicReply).toMatch(/permission/i);
    expect(result.publicReply).not.toMatch(/MCP-123|Permission denied/i);
  });

  it("uses a connector-failure message without provider jargon", async () => {
    executeGatewayRequest.mockResolvedValue({ status: 502, error: "Graph API 401 tenant_abc MCP-99" });
    const result = await handleWhatsAppInboundMessage(env(), inbound("Find the Coal Search document"));
    expect(result.publicReply).toMatch(/can’t reach|try again/i);
    expect(result.publicReply).not.toMatch(/Graph API|tenant_abc|MCP-99/i);
  });

  it("uses a no-result message when search is empty", async () => {
    executeGatewayRequest.mockResolvedValue({ status: 200, result: { results: [] } });
    const result = await handleWhatsAppInboundMessage(env(), inbound("Find a document that does not exist xyz"));
    expect(result.publicReply).toMatch(/couldn’t find that/i);
  });

  it("does not start tools until a multi-company user picks a company", async () => {
    const runtime = env();
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
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        } as ReturnType<D1Database["prepare"]>;
      }
      return stmt;
    }) as D1Database["prepare"];
    const result = await handleWhatsAppInboundMessage(runtime, inbound("Find the Coal Search document"));
    expect(result.outcome).toBe("company_selection");
    expect(result.publicReply).toMatch(/Which company would you like me to use/i);
    expect(executeGatewayRequest).not.toHaveBeenCalled();
  });

  it("answers a pricing capability question without MCP", async () => {
    const result = await handleWhatsAppInboundMessage(env(), inbound("Can you price jobs up?"));
    expect(result.outcome).toBe("answered");
    expect(executeGatewayRequest).not.toHaveBeenCalled();
    expect(result.publicReply).toMatch(/pricing|rates|documents/i);
  });

  it("includes prior turns on a follow-up search", async () => {
    executeGatewayRequest.mockResolvedValue({
      status: 200,
      result: { results: [{ id: "doc_1", title: "Sales", snippet: "12k this month" }] },
    });
    const runtime = env();
    await handleWhatsAppInboundMessage(runtime, inbound("What were sales this month?"));
    executeGatewayRequest.mockClear();
    executeGatewayRequest.mockResolvedValue({
      status: 200,
      result: { results: [{ id: "doc_2", title: "Sales last month", snippet: "10k last month" }] },
    });
    await handleWhatsAppInboundMessage(runtime, inbound("What about last month?"));
    const query = String((executeGatewayRequest.mock.calls[0]?.[1] as { arguments?: { query?: string } })?.arguments?.query ?? "");
    expect(query).toMatch(/last month/i);
    expect(query).toMatch(/sales this month/i);
  });

  it("does not send a progress update when the final answer is already ready", async () => {
    executeGatewayRequest.mockResolvedValue({
      status: 200,
      result: { results: [{ id: "doc_coal", title: "Coal Search", snippet: "Mineral rights search." }] },
    });
    const result = await handleWhatsAppInboundMessage(env(), inbound("Find the Coal Search document"));
    const bodies = sendWhatsAppTextMock.mock.calls.map((call) => String(call[1]?.body ?? ""));
    expect(result.acknowledgementSent).toBe(true);
    expect(sendWhatsAppTextMock).toHaveBeenCalledTimes(2);
    expect(bodies.some((body) => body === STILL_WORKING_MESSAGE)).toBe(false);
    expect(bodies.filter((body) => /found the relevant source|pulling the details together/i.test(body))).toHaveLength(0);
  });
});

describe("WhatsApp progress copy", () => {
  it("keeps progress and fallback messages user-safe", () => {
    expect(progressMessage("seed-a")).not.toMatch(/queue|MCP|database|wamid/i);
    expect(STILL_WORKING_MESSAGE).toMatch(/still working/i);
    expect(STILL_WORKING_MESSAGE).not.toMatch(/timeout|error|stack/i);
  });
});

describe("WhatsApp quality UX signals", () => {
  it("flags a slow acknowledgement and an unnecessary greeting tool call", () => {
    const slowAck = detectQualitySignals({
      interactionId: "int_1",
      companyId: "co_a",
      channel: "whatsapp",
      usage: [
        {
          toolName: "whatsapp.send",
          success: true,
          durationMs: 8000,
          metadata: { channel: "whatsapp", acknowledgementMs: 8000, intent: "knowledge_search", acknowledgementSent: true, finalSent: true },
        },
      ],
    });
    expect(slowAck.some((signal) => signal.category === "whatsapp_slow_ack")).toBe(true);

    const greetingTool = detectQualitySignals({
      interactionId: "int_2",
      companyId: "co_a",
      channel: "whatsapp",
      usage: [
        {
          toolName: "search_company_knowledge",
          success: true,
          metadata: { channel: "whatsapp", intent: "greeting", finalSent: true },
        },
      ],
    });
    expect(greetingTool.some((signal) => signal.category === "whatsapp_unnecessary_tool")).toBe(true);

    const abandoned = detectQualitySignals({
      interactionId: "int_3",
      companyId: "co_a",
      channel: "whatsapp",
      usage: [
        {
          toolName: "whatsapp.send",
          success: true,
          durationMs: 70_000,
          metadata: {
            channel: "whatsapp",
            acknowledgementSent: true,
            acknowledgementMs: 1200,
            progressSent: true,
            finalSent: false,
            totalMs: 70_000,
            intent: "knowledge_search",
          },
        },
      ],
    });
    expect(abandoned.some((signal) => signal.category === "whatsapp_no_final_after_ack")).toBe(true);
    expect(abandoned.some((signal) => signal.category === "whatsapp_progress_abandoned")).toBe(true);
    expect(abandoned.some((signal) => signal.category === "whatsapp_slow_total")).toBe(true);

    const retry = detectQualitySignals({
      interactionId: "int_4",
      companyId: "co_a",
      channel: "whatsapp",
      usage: [{ toolName: "whatsapp.send", success: true, metadata: { channel: "whatsapp" } }],
      recentSameActor: [
        { interactionId: "int_prev", recordedAt: new Date().toISOString(), toolName: "search_company_knowledge" },
      ],
    });
    expect(retry.some((signal) => signal.category === "user_immediate_retry")).toBe(true);
  });
});

describe("WhatsApp capability lookup", () => {
  it("reads connected connectors for the company only", async () => {
    const reply = await capabilityReplyForCompany(env(), "co_a");
    expect(reply).toMatch(/emails|Xero/i);
    expect(reply).not.toMatch(/Caddington/i);
  });
});
