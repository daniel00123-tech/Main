import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID, INFRA_WHATSAPP_PHONE_NUMBER_ID } from "./whatsapp-assets";
import { FIRST_RESPONSE_FAILSAFE_COPY, isWhatsAppFastLaneText, tryWhatsAppFastLane } from "./whatsapp-fast-lane";
import { persistWhatsAppInboundEvent, processWhatsAppInboundJob } from "./whatsapp-webhook";
import { computeWhatsAppUxMetrics } from "./whatsapp-ops";
import { isInstantLocalTurn } from "./whatsapp-realtime";
const { sendWhatsAppTextMock, getUserByMobileE164, toSessionUser } = vi.hoisted(() => ({
  sendWhatsAppTextMock: vi.fn(),
  getUserByMobileE164: vi.fn(),
  toSessionUser: vi.fn(),
}));

vi.mock("./whatsapp-send", async () => {
  const actual = await vi.importActual<typeof import("./whatsapp-send")>("./whatsapp-send");
  return {
    ...actual,
    sendWhatsAppText: sendWhatsAppTextMock,
    sendWhatsAppReadStatus: vi.fn().mockResolvedValue({ ok: true, supported: true, status: 200 }),
    sendWhatsAppTypingIndicator: vi.fn().mockResolvedValue({ ok: true, supported: true, status: 200 }),
    sendWhatsAppInteractiveButtons: vi.fn().mockResolvedValue({
      ok: false,
      kind: "customer_service_reply",
      error: "interactive_fallback",
      retryable: false,
      attempts: 1,
      httpStatus: null,
      rawAccepted: false,
    }),
  };
});
vi.mock("../auth/users", () => ({ getUserByMobileE164, toSessionUser }));

import { handleWhatsAppInboundMessage } from "./whatsapp-orchestrator";

function inboundPayload(text: string, wamid: string) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: INFRA_WHATSAPP_PHONE_NUMBER_ID },
              messages: [{ id: wamid, from: "447932609444", type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  });
}

function env(options?: { throwOnInsert?: boolean }): Env {
  const events = new Map<string, Record<string, unknown>>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM users") || sql.includes("FROM company_memberships")) {
                return {
                  id: "user_cbe6612b-c58b-472f-914b-be92eb6c8935",
                  email: "dan@example.com",
                  display_name: "Dan",
                  status: "active",
                  mobile_e164: "+447932609444",
                  company_id: "co_caddington",
                  role: "admin",
                  company_name: "Caddington",
                };
              }
              if (sql.includes("FROM whatsapp_inbound_events")) {
                if (sql.includes("wamid")) {
                  return [...events.values()].find((row) => row.wamid === args[0]) ?? null;
                }
                if (sql.includes("WHERE id")) return events.get(String(args[0])) ?? null;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM company_memberships")) {
                return {
                  results: [
                    {
                      company_id: "co_caddington",
                      role: "admin",
                      status: "active",
                      company_name: "Caddington",
                      company_slug: "caddington",
                    },
                  ],
                };
              }
              if (sql.includes("FROM whatsapp_inbound_events")) {
                return { results: [...events.values()] };
              }
              return { results: [] };
            },
            async run() {
              if (options?.throwOnInsert && sql.includes("INSERT INTO whatsapp_inbound_events")) {
                throw new Error("D1 insert failed: no such column");
              }
              if (sql.includes("INSERT INTO whatsapp_inbound_events")) {
                const id = String(args[0]);
                events.set(id, {
                  id,
                  wamid: args[1],
                  sender_e164: args[4],
                  processed: 0,
                  identity_found: 0,
                  payload_json: args[7] ?? args[6],
                  received_at: new Date().toISOString(),
                });
              }
              if (sql.includes("UPDATE whatsapp_inbound_events")) {
                const key = args[args.length - 1];
                const row = events.get(String(key)) ?? [...events.values()].find((item) => item.wamid === key);
                if (row) {
                  if (sql.includes("processed = 1")) row.processed = 1;
                  if (sql.includes("first_visible_at")) row.first_visible_at = new Date().toISOString();
                  if (sql.includes("identity_found")) row.identity_found = 1;
                  if (sql.includes("inbound_text")) row.inbound_text = args[0];
                }
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

describe("WhatsApp V4.2 persist fail-open and fast lane", () => {
  it("treats hi/thanks as fast-lane text without depending on van-policy copy", () => {
    expect(isWhatsAppFastLaneText("hi")).toBe(true);
    expect(isInstantLocalTurn("hi")).toBe(true);
    expect(isWhatsAppFastLaneText("what document tells me about van policy")).toBe(false);
  });

  it("persist insert failure does not throw and still allows queue payload processing", async () => {
    const stored = await persistWhatsAppInboundEvent(env({ throwOnInsert: true }), {
      rawBody: inboundPayload("hi", "wamid.v42.hi"),
      signatureValid: true,
      signatureConfigured: true,
    });
    expect(stored.persisted).toBe(false);
    expect(stored.duplicate).toBe(false);
    expect(stored.error).toMatch(/insert|column/i);
  });

  it("fast-lane greeting sends a local reply without MCP", async () => {
    sendWhatsAppTextMock.mockResolvedValue({
      ok: true,
      kind: "customer_service_reply",
      messageId: "wamid.OUT",
      attempts: 1,
      httpStatus: 200,
      rawAccepted: true,
    });
    const result = await tryWhatsAppFastLane(env(), {
      wamid: "wamid.v42.fast",
      from: "447932609444",
      type: "text",
      text: "hi",
      phoneNumberId: INFRA_WHATSAPP_PHONE_NUMBER_ID,
      businessAccountId: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
      timestamp: "1788086100",
    });
    expect(result.attempted).toBe(true);
    expect(result.sent).toBe(true);
    expect(result.reply).toMatch(/Hi 👋/);
    expect(sendWhatsAppTextMock).toHaveBeenCalled();
  });

  it("claim-busy no longer throws from the consumer", async () => {
    const runtime = env();
    const stored = await persistWhatsAppInboundEvent(runtime, {
      rawBody: inboundPayload("hi", "wamid.v42.busy"),
      signatureValid: true,
      signatureConfigured: true,
    });
    await runtime.DB.prepare(`UPDATE whatsapp_inbound_events SET error = 'PROCESSING' WHERE id = ?`)
      .bind(stored.eventId)
      .run();
    await expect(
      processWhatsAppInboundJob(runtime, {
        kind: "whatsapp_inbound",
        eventId: stored.eventId,
        receivedAt: new Date().toISOString(),
        signatureValid: true,
        rawPayload: inboundPayload("hi", "wamid.v42.busy"),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("WhatsApp V4.2 outbound delivery evidence", () => {
  it("does not mark sent when Meta returns HTTP 200 without a message id", async () => {
    const actual = await vi.importActual<typeof import("./whatsapp-send")>("./whatsapp-send");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ messages: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await actual.sendWhatsAppText(
      {
        DB: {} as D1Database,
        ENVIRONMENT: "test",
        SESSION_SECRET: "test",
        ALLOWED_ORIGINS: "http://localhost:5173",
        WHATSAPP_PHONE_NUMBER_ID: INFRA_WHATSAPP_PHONE_NUMBER_ID,
        WHATSAPP_BUSINESS_ACCOUNT_ID: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
        WHATSAPP_ACCESS_TOKEN: "EAAG-test-token-not-real",
        META_APP_SECRET: "meta-app-secret-for-tests-only",
        WHATSAPP_OUTBOUND_AI_ENABLED: "true",
      } as Env,
      { toE164: "+447932609444", body: "Hi", inCustomerServiceWindow: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.httpStatus).toBe(200);
    vi.unstubAllGlobals();
  });
});

describe("WhatsApp V4.2 failsafe and health", () => {
  it("exposes an awaited first-response failsafe copy", () => {
    expect(FIRST_RESPONSE_FAILSAFE_COPY).toMatch(/looking at that now/i);
  });

  it("marks health RED for greeting silence, queue age, and DLQ", async () => {
    const now = new Date().toISOString();
    const rows = [
      {
        identity_found: 1,
        received_at: new Date(Date.now() - 8_000).toISOString(),
        inbound_text: "hi",
        wamid: "wamid.HBgNexample",
        processed: 0,
        first_visible_at: null,
        reply_sent_at: null,
      },
      {
        identity_found: 1,
        received_at: new Date(Date.now() - 12_000).toISOString(),
        inbound_text: "van policy",
        wamid: "wamid.HBgNexample2",
        processed: 0,
        error: "DEAD_LETTER",
        dlq_at: now,
        first_visible_at: null,
        reply_sent_at: null,
      },
    ];
    const runtime = {
      DB: {
        prepare() {
          return {
            bind() {
              return this;
            },
            async all() {
              return { results: rows };
            },
            async run() {
              return { success: true };
            },
          };
        },
      },
    } as unknown as Env;
    const metrics = await computeWhatsAppUxMetrics(runtime);
    expect(metrics.healthState).toBe("RED");
    expect(metrics.redReasons.length).toBeGreaterThan(0);
    expect(metrics.liveMetaInbound).toBe(2);
  });
});

describe("WhatsApp V4.2 greeting is not blocked by a prior tool turn", () => {
  it("answers hi locally even when a van-policy sibling exists", async () => {
    sendWhatsAppTextMock.mockResolvedValue({
      ok: true,
      kind: "customer_service_reply",
      messageId: "wamid.OUT3",
      attempts: 1,
      httpStatus: 200,
      rawAccepted: true,
    });
    getUserByMobileE164.mockResolvedValue({
      id: "user_cbe6612b-c58b-472f-914b-be92eb6c8935",
      email: "dan@example.com",
      status: "active",
      mobile_e164: "+447932609444",
    });
    toSessionUser.mockResolvedValue({
      userId: "user_cbe6612b-c58b-472f-914b-be92eb6c8935",
      email: "dan@example.com",
      displayName: "Dan",
      isPlatformAdmin: true,
      memberships: [{ companyId: "co_caddington", role: "admin", customRoleId: null, teamId: null }],
      credentialsVersion: 1,
    });
    const runtime = env();
    await persistWhatsAppInboundEvent(runtime, {
      rawBody: inboundPayload("what document tells me about van policy", "wamid.v42.van"),
      signatureValid: true,
      signatureConfigured: true,
    });
    const result = await handleWhatsAppInboundMessage(
      runtime,
      {
        wamid: "wamid.v42.hi-after-van",
        from: "447932609444",
        type: "text",
        text: "hi",
        phoneNumberId: INFRA_WHATSAPP_PHONE_NUMBER_ID,
        businessAccountId: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
        timestamp: "1788086100",
      },
      { alreadyRecorded: true, coalesceMs: 200 },
    );
    expect(result.publicReply).toMatch(/Hi 👋/);
    expect(result.intent).toBe("greeting");
  });
});
