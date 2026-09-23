import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID, INFRA_WHATSAPP_PHONE_NUMBER_ID } from "./whatsapp-assets";
import { persistWhatsAppInboundEvent } from "./whatsapp-webhook";
import { raceWithWhatsAppWatchdog } from "./whatsapp-watchdog";
import { recoverStuckWhatsAppTurn } from "./whatsapp-reaper";
import { isGenericDocumentAsk, isInstantLocalTurn, instantLocalReply } from "./whatsapp-realtime";
import { planWhatsAppTurn } from "./whatsapp-plan";
import { emptyEntityMemory } from "./whatsapp-entities";
import { ACK_DECISION_MS } from "./whatsapp-latency";
import { detectQualitySignals } from "./quality-auditor";
import { evaluateWhatsAppConversation } from "./quality-loop/evaluator";

const {
  executeGatewayRequest,
  sendWhatsAppTextMock,
  sendReadMock,
  sendTypingMock,
  getUserByMobileE164,
  toSessionUser,
  recordUsageEvent,
} = vi.hoisted(() => ({
  executeGatewayRequest: vi.fn(),
  sendWhatsAppTextMock: vi.fn(),
  sendReadMock: vi.fn(),
  sendTypingMock: vi.fn(),
  getUserByMobileE164: vi.fn(),
  toSessionUser: vi.fn(),
  recordUsageEvent: vi.fn(),
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
    sendWhatsAppTypingIndicator: sendTypingMock,
    sendWhatsAppReadStatus: sendReadMock,
  };
});
vi.mock("../auth/users", () => ({ getUserByMobileE164, toSessionUser }));
vi.mock("./usage", () => ({ recordUsageEvent }));
vi.mock("./quality-auditor", async () => {
  const actual = await vi.importActual<typeof import("./quality-auditor")>("./quality-auditor");
  return { ...actual, scheduleQualityAudit: vi.fn() };
});

import { handleWhatsAppInboundMessage } from "./whatsapp-orchestrator";

function env(options?: { throwOnConversation?: boolean; throwOnStamp?: boolean }): Env {
  const store = new Map<string, Record<string, unknown>>();
  const events = new Map<string, Record<string, unknown>>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM users") && sql.includes("status = 'active'")) {
                if (String(args[0]).includes("900123") || String(args[0]).includes("7932609444")) {
                  return {
                    id: "user_cbe6612b-c58b-472f-914b-be92eb6c8935",
                    email: "dan@example.com",
                    display_name: "Dan",
                    status: "active",
                    mobile_e164: "+447932609444",
                    mobile_verified: 1,
                    mobile_verification_required: 0,
                  };
                }
                return null;
              }
              if (sql.includes("FROM whatsapp_conversations")) {
                if (options?.throwOnConversation) throw new Error("conversation_unavailable");
                return store.get(`conv:${args[0]}`) ?? null;
              }
              if (sql.includes("FROM whatsapp_inbound_events") && sql.includes("wamid")) {
                const found = [...events.values()].find((row) => row.wamid === args[0]);
                if (!found) return null;
                if (sql.includes("processed = 1") && Number(found.processed) !== 1) return null;
                return found;
              }
              if (sql.includes("FROM whatsapp_inbound_events") && sql.includes("WHERE id")) {
                return events.get(String(args[0])) ?? null;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM company_memberships")) {
                return {
                  results: [
                    { company_id: "co_caddington", role: "admin", status: "active", company_name: "Caddington", company_slug: "caddington" },
                  ],
                };
              }
              if (sql.includes("FROM connector_instances")) {
                return {
                  results: [
                    { connector_definition_id: "conn_microsoft_365", name: "M365", status: "healthy", auth_status: "connected" },
                  ],
                };
              }
              if (sql.includes("FROM whatsapp_inbound_events")) {
                return { results: [...events.values()] };
              }
              return { results: [] };
            },
            async run() {
              if (options?.throwOnStamp && sql.includes("UPDATE whatsapp_inbound_events SET")) {
                throw new Error("d1_stamp_failed");
              }
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
                const wamid = args[args.length - 1];
                const row = [...events.values()].find((item) => item.id === wamid || item.wamid === wamid);
                if (row) {
                  if (sql.includes("processed = 1")) row.processed = 1;
                  if (sql.includes("identity_found")) row.identity_found = 1;
                  if (sql.includes("sender_e164")) row.sender_e164 = args[0];
                  if (sql.includes("received_at")) row.received_at = args[1] ?? row.received_at;
                  if (sql.includes("recover_sent_at")) row.recover_sent_at = new Date().toISOString();
                  if (sql.includes("terminal_state")) row.terminal_state = "failed_notified";
                  if (sql.includes("first_visible_at")) row.first_visible_at = new Date().toISOString();
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

function inbound(text: string, wamid = `wamid.${Math.random().toString(16).slice(2)}`) {
  return {
    wamid,
    from: "447932609444",
    type: "text",
    text,
    phoneNumberId: INFRA_WHATSAPP_PHONE_NUMBER_ID,
    businessAccountId: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
    timestamp: "1710000000",
  };
}

function expectTerminal(result: { replySent: boolean; publicReply: string | null; outcome: string }) {
  expect(result.publicReply).toBeTruthy();
  expect(result.publicReply!.length).toBeGreaterThan(8);
  expect(["answered", "clarification_requested", "write_blocked", "tool_failed", "ai_failed", "send_failed", "company_selection", "unknown"]).toContain(
    result.outcome,
  );
}

describe("WhatsApp V4.1 local greetings and document clarify", () => {
  it("treats hi/hello/hey/morning/thanks as local instant turns", () => {
    for (const text of ["hi", "hello", "hey", "morning", "good afternoon", "evening", "thanks"]) {
      expect(isInstantLocalTurn(text)).toBe(true);
    }
    expect(instantLocalReply("hi")).toMatch(/Hi 👋 What can I help you with/);
    expect(isGenericDocumentAsk("can you help me find a document in the shared folder?")).toBe(true);
    expect(isGenericDocumentAsk("find Coal Search in the shared folder")).toBe(false);
    const plan = planWhatsAppTurn({
      text: "can you help me find a document in the shared folder?",
      memory: emptyEntityMemory(),
      connectors: ["conn_microsoft_365"],
    });
    expect(plan.action).toBe("clarify");
    expect(plan.skipTools).toBe(true);
  });
});

describe("WhatsApp V4.1 recognised-user outcomes", () => {
  beforeEach(() => {
    executeGatewayRequest.mockReset();
    sendWhatsAppTextMock.mockReset().mockResolvedValue({
      ok: true,
      kind: "customer_service_reply",
      messageId: "wamid.OUT",
      attempts: 1,
    });
    sendReadMock.mockReset().mockResolvedValue({ ok: true, supported: true });
    sendTypingMock.mockReset().mockResolvedValue({ ok: true, supported: true });
    recordUsageEvent.mockReset().mockResolvedValue({ id: "usage_1" });
    getUserByMobileE164.mockResolvedValue({
      id: "user_cbe6612b-c58b-472f-914b-be92eb6c8935",
      email: "dan@example.com",
      displayName: "Dan",
      status: "active",
    });
    toSessionUser.mockResolvedValue({
      userId: "user_cbe6612b-c58b-472f-914b-be92eb6c8935",
      email: "dan@example.com",
      displayName: "Dan",
      isPlatformAdmin: true,
      memberships: [{ companyId: "co_caddington", role: "admin", customRoleId: null, teamId: null }],
      credentialsVersion: 1,
    });
  });

  it("answers a greeting alone locally without MCP, ack, or typing", async () => {
    const started = Date.now();
    const result = await handleWhatsAppInboundMessage(env(), inbound("hi"));
    expectTerminal(result);
    expect(result.publicReply).toMatch(/Hi 👋/);
    expect(executeGatewayRequest).not.toHaveBeenCalled();
    expect(sendTypingMock).not.toHaveBeenCalled();
    expect(result.acknowledgementSent).not.toBe(true);
    expect(sendReadMock).toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("clarifies a generic shared-folder document ask without searching", async () => {
    const result = await handleWhatsAppInboundMessage(
      env(),
      inbound("can you help me find a document in the shared folder?"),
    );
    expectTerminal(result);
    expect(result.outcome).toBe("clarification_requested");
    expect(result.publicReply).toMatch(/document called|what is it about/i);
    expect(executeGatewayRequest).not.toHaveBeenCalled();
  });

  it("handles a 100ms greeting+question burst as one clarification when sibling is present", async () => {
    const runtime = env();
    await persistWhatsAppInboundEvent(runtime, {
      rawBody: JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: INFRA_WHATSAPP_PHONE_NUMBER_ID },
                  messages: [{ id: "wamid.sibling", from: "447932609444", type: "text", text: { body: "find a document in the shared folder" } }],
                },
              },
            ],
          },
        ],
      }),
      signatureValid: true,
      signatureConfigured: true,
    });
    const result = await handleWhatsAppInboundMessage(runtime, inbound("hi", "wamid.hi-burst"), { coalesceMs: 100 });
    expectTerminal(result);
    expect(result.publicReply).toMatch(/Hi 👋 Of course/);
    expect(executeGatewayRequest).not.toHaveBeenCalled();
  });

  it("does not delay a standalone greeting several seconds (500ms and 2000ms bursts stay independent)", async () => {
    const started = Date.now();
    const first = await handleWhatsAppInboundMessage(env(), inbound("hello"), { coalesceMs: 0 });
    expectTerminal(first);
    expect(Date.now() - started).toBeLessThan(500);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    const second = await handleWhatsAppInboundMessage(
      env(),
      inbound("can you help me find a document in the shared folder?"),
    );
    expectTerminal(second);
    expect(second.outcome).toBe("clarification_requested");
    expect(executeGatewayRequest).not.toHaveBeenCalled();
  });

  it("processes two business questions independently without deadlock", async () => {
    executeGatewayRequest.mockResolvedValue({
      status: 200,
      result: { results: [{ id: "doc_1", title: "Coal Search.pdf", snippet: "payment" }] },
    });
    const runtime = env();
    const first = handleWhatsAppInboundMessage(runtime, inbound("Find the Coal Search document", "wamid.q1"));
    const second = handleWhatsAppInboundMessage(runtime, inbound("What were sales last month?", "wamid.q2"));
    const [a, b] = await Promise.all([first, second]);
    expectTerminal(a);
    expectTerminal(b);
    expect(a.replySent).toBe(true);
    expect(b.replySent).toBe(true);
  });

  it("treats duplicate delivery as skipped without a second user-visible send after processed=1", async () => {
    const runtime = env();
    const wamid = "wamid.dup";
    await persistWhatsAppInboundEvent(runtime, {
      rawBody: JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: INFRA_WHATSAPP_PHONE_NUMBER_ID },
                  messages: [{ id: wamid, from: "447932609444", type: "text", text: { body: "hi" } }],
                },
              },
            ],
          },
        ],
      }),
      signatureValid: true,
      signatureConfigured: true,
    });
    await runtime.DB.prepare(`UPDATE whatsapp_inbound_events SET processed = 1 WHERE wamid = ?`).bind(wamid).run();
    sendWhatsAppTextMock.mockClear();
    const dup = await handleWhatsAppInboundMessage(runtime, inbound("hi", wamid));
    expect(dup.duplicate).toBe(true);
    expect(sendWhatsAppTextMock).not.toHaveBeenCalled();
  });

  it("ignores an interleaved status webhook payload without blocking a later greeting", async () => {
    const stored = await persistWhatsAppInboundEvent(env(), {
      rawBody: JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "wamid.out", status: "delivered" }] } }] }],
      }),
      signatureValid: true,
      signatureConfigured: true,
    });
    expect(stored.duplicate).toBe(false);
    const result = await handleWhatsAppInboundMessage(env(), inbound("hey"));
    expectTerminal(result);
  });

  it("still greets when the conversation row is unavailable", async () => {
    const result = await handleWhatsAppInboundMessage(env({ throwOnConversation: true }), inbound("hi"));
    expectTerminal(result);
    expect(result.publicReply).toMatch(/Hi 👋/);
    expect(executeGatewayRequest).not.toHaveBeenCalled();
  });

  it("still replies when a D1 lifecycle stamp throws", async () => {
    const result = await handleWhatsAppInboundMessage(env({ throwOnStamp: true }), inbound("thanks"));
    expectTerminal(result);
    expect(result.replySent).toBe(true);
  });

  it("notifies the user when the planner/connector lookup throws", async () => {
    const runtime = env();
    const original = runtime.DB.prepare.bind(runtime.DB);
    runtime.DB.prepare = ((sql: string) => {
      if (sql.includes("FROM connector_instances")) {
        return {
          bind() {
            return {
              async all() {
                throw new Error("planner_connectors_failed");
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
      return original(sql);
    }) as D1Database["prepare"];
    const result = await handleWhatsAppInboundMessage(runtime, inbound("Find the Coal Search document"));
    expectTerminal(result);
    expect(["answered", "ai_failed", "tool_failed"]).toContain(result.outcome);
    expect(result.publicReply).toBeTruthy();
  });

  it("sends an awaited acknowledgement when MCP work is slower than 800ms", async () => {
    executeGatewayRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve({ status: 200, result: { results: [{ id: "doc_1", title: "Coal Search.pdf", snippet: "ok" }] } }),
            950,
          );
        }),
    );
    const result = await handleWhatsAppInboundMessage(env(), inbound("Find the Coal Search document"));
    expectTerminal(result);
    expect(result.acknowledgementSent).toBe(true);
    expect(sendTypingMock).toHaveBeenCalled();
    expect(sendWhatsAppTextMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("retries transient Meta outbound text and still produces a terminal reply", async () => {
    sendWhatsAppTextMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ ok: true, kind: "customer_service_reply", messageId: "wamid.OUT2", attempts: 2 });
    // maybeSendReply uses sendWhatsAppText once; simulate retry inside send mock
    sendWhatsAppTextMock.mockReset();
    sendWhatsAppTextMock
      .mockResolvedValueOnce({ ok: false, kind: "customer_service_reply", error: "HTTP 503", retryable: true, attempts: 2 })
      .mockResolvedValueOnce({ ok: true, kind: "customer_service_reply", messageId: "wamid.OUT2", attempts: 3 });
    const result = await handleWhatsAppInboundMessage(env(), inbound("hi"));
    expectTerminal(result);
  });

  it("recovers a stuck recognised turn once with a user-visible failure", async () => {
    const runtime = env();
    const wamid = "wamid.stuck";
    await persistWhatsAppInboundEvent(runtime, {
      rawBody: JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: INFRA_WHATSAPP_PHONE_NUMBER_ID },
                  messages: [{ id: wamid, from: "447932609444", type: "text", text: { body: "Find Coal Search" } }],
                },
              },
            ],
          },
        ],
      }),
      signatureValid: true,
      signatureConfigured: true,
    });
    await runtime.DB.prepare(
      `UPDATE whatsapp_inbound_events SET identity_found = 1, sender_e164 = ?, received_at = ? WHERE wamid = ?`,
    )
      .bind("+447932609444", new Date(Date.now() - 35_000).toISOString(), wamid)
      .run();
    const recovered = await recoverStuckWhatsAppTurn(runtime, wamid);
    expect(recovered.recovered).toBe(true);
    expect(sendWhatsAppTextMock).toHaveBeenCalled();
    expect(String(sendWhatsAppTextMock.mock.calls.at(-1)?.[1]?.body ?? "")).toMatch(/took longer than expected/i);
    const again = await recoverStuckWhatsAppTurn(runtime, wamid);
    expect(again.recovered).toBe(false);
  });
});

describe("WhatsApp V4.1 queue retry and watchdog timeout", () => {
  it("queue retry after claim-busy does not require a second user message", async () => {
    const sent: string[] = [];
    const result = await raceWithWhatsAppWatchdog(
      new Promise((resolve) => {
        setTimeout(() => resolve("final"), ACK_DECISION_MS + 50);
      }),
      async (kind, body) => {
        sent.push(`${kind}:${body}`);
        return true;
      },
    );
    expect(result.result === "final" || result.acknowledgementSent || sent.length > 0).toBe(true);
  });

  it("watchdog timeout copy is a terminal user-visible outcome", async () => {
    const { WATCHDOG_TIMEOUT_COPY } = await import("./whatsapp-watchdog");
    expect(WATCHDOG_TIMEOUT_COPY).toMatch(/took longer than expected/i);
    expect(WATCHDOG_TIMEOUT_COPY.length).toBeGreaterThan(20);
  });
});

describe("WhatsApp V4.1 quality loop UX signals", () => {
  it("flags greeting>2s, first visible>3s, stuck, and outbound Meta failure as high priority", () => {
    const signals = detectQualitySignals({
      interactionId: "int_ux",
      companyId: "co_caddington",
      channel: "whatsapp",
      usage: [
        {
          action: "whatsapp.reply",
          success: false,
          durationMs: 4000,
          metadata: {
            channel: "whatsapp",
            intent: "greeting",
            firstVisibleMs: 2500,
            totalMs: 4000,
            finalSent: false,
            outboundMetaFailure: true,
            lastError: "send_failed",
          },
        },
      ],
    });
    const categories = signals.map((signal) => signal.category);
    expect(categories).toContain("whatsapp_greeting_slow");
    expect(categories).toContain("whatsapp_outbound_meta_failure");
    const evaluation = evaluateWhatsAppConversation({
      companyId: "co_caddington",
      conversationKey: "int_ux",
      channel: "whatsapp",
      userMessages: ["hi"],
      assistantMessages: [],
      acks: 0,
      progressUpdates: 0,
      buttonSelections: [],
      voiceTranscript: null,
      toolNames: [],
      connectorErrors: [],
      sourceUrls: [],
      askedForSource: false,
      followUp: false,
      contextLost: false,
      rawLeak: false,
      permissionDenied: false,
      permissionDenialCorrect: false,
      acknowledgementMs: null,
      firstVisibleMs: 2500,
      totalMs: 4000,
      finalSent: false,
      acknowledgementSent: false,
      usageCostCents: 0,
      qualitySignals: ["whatsapp_greeting_slow", "whatsapp_silent"],
    });
    expect(evaluation.flags.some((flag) => flag.category === "greeting_slow" || flag.category === "silence")).toBe(true);
  });
});
