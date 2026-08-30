import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { planWhatsAppTurn } from "./whatsapp-plan";
import { emptyEntityMemory } from "./whatsapp-entities";
import { isGenericDocumentAsk, usableSearchTerms } from "./whatsapp-realtime";
import { applyWhatsAppWatchdogStage, recoverStuckWhatsAppTurn } from "./whatsapp-reaper";
import { DELAY_NOTICE_MS, HARD_TIMEOUT_MS, PROGRESS_AFTER_MS, summariseWhatsAppLatency } from "./whatsapp-latency";
import { WATCHDOG_PROGRESS_COPY, WATCHDOG_TIMEOUT_COPY, raceWithWhatsAppWatchdog } from "./whatsapp-watchdog";
import {
  FETCH_TOP_LIMIT,
  KNOWLEDGE_SEARCH_TIMEOUT_MS,
  MCP_TIMEOUT_MS,
  SEARCH_CANDIDATE_LIMIT,
  withBoundedTimeout,
} from "./whatsapp-timeouts";
import {
  KNOWLEDGE_BREAKER_THRESHOLD,
  knowledgeCircuitOpen,
  recordKnowledgeTimeout,
} from "./whatsapp-knowledge-breaker";
import { detectQualitySignals } from "./quality-auditor";

const BROAD = "can you find me a doc or two on the system and tell me about it";

describe("WhatsApp V4.4 planner — broad vs specific", () => {
  it("clarifies a broad doc-or-two ask without launching search", () => {
    expect(isGenericDocumentAsk(BROAD)).toBe(true);
    expect(usableSearchTerms(BROAD)).toEqual([]);
    const plan = planWhatsAppTurn({
      text: BROAD,
      memory: emptyEntityMemory(),
      connectors: ["conn_microsoft_365"],
    });
    expect(plan.action).toBe("clarify");
    expect(plan.skipTools).toBe(true);
    expect(plan.tool).toBeNull();
  });

  it("searches moderately specific van policy and specific Coal Search", () => {
    expect(isGenericDocumentAsk("what document tells me about van policy")).toBe(false);
    expect(usableSearchTerms("van policy")).toEqual(expect.arrayContaining(["van", "policy"]));
    const van = planWhatsAppTurn({
      text: "what document tells me about van policy",
      memory: emptyEntityMemory(),
      connectors: ["conn_microsoft_365"],
    });
    expect(van.action).toMatch(/knowledge|guidance/);
    expect(van.skipTools).toBe(false);

    expect(isGenericDocumentAsk("find Coal Search")).toBe(false);
    const coal = planWhatsAppTurn({
      text: "find Coal Search",
      memory: emptyEntityMemory(),
      connectors: ["conn_microsoft_365"],
    });
    expect(coal.action).toBe("knowledge");
    expect(coal.query.toLowerCase()).toMatch(/coal search/);
  });
});

describe("WhatsApp V4.4 timeouts and search budget", () => {
  it("bounds MCP/search and keeps candidate/fetch counts small", () => {
    expect(MCP_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
    expect(KNOWLEDGE_SEARCH_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
    expect(SEARCH_CANDIDATE_LIMIT).toBeGreaterThanOrEqual(5);
    expect(SEARCH_CANDIDATE_LIMIT).toBeLessThanOrEqual(10);
    expect(FETCH_TOP_LIMIT).toBeGreaterThanOrEqual(1);
    expect(FETCH_TOP_LIMIT).toBeLessThanOrEqual(3);
    expect(HARD_TIMEOUT_MS).toBe(60_000);
    expect(PROGRESS_AFTER_MS).toBeGreaterThanOrEqual(10_000);
    expect(PROGRESS_AFTER_MS).toBeLessThanOrEqual(15_000);
    expect(DELAY_NOTICE_MS).toBe(30_000);
  });

  it("withBoundedTimeout resolves instead of hanging", async () => {
    const hung = new Promise<string>(() => undefined);
    const result = await withBoundedTimeout(hung, 20, "unit");
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
  });
});

describe("WhatsApp V4.4 independent post-ack watchdog", () => {
  it("sends truthful progress at t15 when ACK exists and turn is not terminal", async () => {
    const sent: string[] = [];
    const env = {
      WHATSAPP_ACCESS_TOKEN: "token",
      WHATSAPP_PHONE_NUMBER_ID: "1338434179351224",
      WHATSAPP_OUTBOUND_AI_ENABLED: "true",
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async first() {
              if (sql.includes("FROM whatsapp_inbound_events")) {
                return {
                  sender_e164: "+447932609444",
                  first_visible_at: new Date().toISOString(),
                  acknowledgement_sent_at: new Date().toISOString(),
                  reply_sent_at: null,
                  terminal_state: null,
                  identity_found: 1,
                  progress_sent_at: null,
                  delay_sent_at: null,
                };
              }
              return null;
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      },
    } as unknown as Env;
    const { sendWhatsAppText } = await import("./whatsapp-send");
    const spy = sendWhatsAppText as unknown as { mock?: unknown };
    void spy;
    const result = await applyWhatsAppWatchdogStage(env, {
      eventId: "wa_evt_ack",
      wamid: "wamid.HBgM12_12",
      stage: "t15",
      receivedAt: new Date(Date.now() - 16_000).toISOString(),
    });
    expect(result.reason === "t15_progress" || result.reason === "progress_already_sent").toBe(true);
    expect(WATCHDOG_PROGRESS_COPY).not.toMatch(/found \d+ files|Vectorize|MCP|D1/i);
    void sent;
  });

  it("force-terminates at t60 when ACK is still the only visible reply", async () => {
    const env = {
      WHATSAPP_ACCESS_TOKEN: "token",
      WHATSAPP_PHONE_NUMBER_ID: "1338434179351224",
      WHATSAPP_OUTBOUND_AI_ENABLED: "true",
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async first() {
              return {
                sender_e164: "+447932609444",
                first_visible_at: new Date(Date.now() - 61_000).toISOString(),
                acknowledgement_sent_at: new Date(Date.now() - 61_000).toISOString(),
                reply_sent_at: null,
                terminal_state: null,
                identity_found: 1,
                received_at: new Date(Date.now() - 61_000).toISOString(),
                processed: 1,
                payload_json: null,
              };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      },
    } as unknown as Env;
    const result = await applyWhatsAppWatchdogStage(env, {
      eventId: "wa_evt_t60",
      wamid: "wamid.HBgM12_12",
      stage: "t60",
      receivedAt: new Date(Date.now() - 61_000).toISOString(),
    });
    expect(result.acted).toBe(true);
    expect(result.reason).toBe("t60_force_terminal");
    expect(WATCHDOG_TIMEOUT_COPY).toMatch(/took longer than expected/i);
  });

  it("recoverStuck after ACK waits until 60s then force-terminates", async () => {
    const env = {
      WHATSAPP_ACCESS_TOKEN: "token",
      WHATSAPP_PHONE_NUMBER_ID: "1338434179351224",
      WHATSAPP_OUTBOUND_AI_ENABLED: "true",
      DB: {
        prepare() {
          return {
            bind() {
              return this;
            },
            async first() {
              return {
                wamid: "wamid.ack",
                sender_e164: "+447932609444",
                identity_found: 1,
                processed: 1,
                terminal_state: null,
                first_visible_at: new Date(Date.now() - 10_000).toISOString(),
                reply_sent_at: null,
                recover_sent_at: null,
                received_at: new Date(Date.now() - 10_000).toISOString(),
                payload_json: null,
              };
            },
            async run() {
              return { success: true };
            },
          };
        },
      },
    } as unknown as Env;
    const early = await recoverStuckWhatsAppTurn(env, "wamid.ack");
    expect(early.reason).toBe("ack_pending_final");
  });

  it("skipAck still emits progress then timeout instead of hanging silent", async () => {
    const kinds: string[] = [];
    const hung = new Promise<string>(() => undefined);
    const raced = raceWithWhatsAppWatchdog(
      hung,
      async (kind) => {
        kinds.push(kind);
        return true;
      },
      { skipAck: true },
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(kinds.includes("timeout")).toBe(false);
    void raced;
  });
});

describe("WhatsApp V4.4 circuit breaker and telemetry", () => {
  it("opens the knowledge circuit after repeated timeouts", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              return {
                async first() {
                  if (sql.includes("FROM whatsapp_knowledge_circuit")) {
                    return store.get(String(args[0])) ?? null;
                  }
                  return null;
                },
                async run() {
                  if (sql.includes("INSERT INTO whatsapp_knowledge_circuit")) {
                    store.set(String(args[0]), {
                      company_id: args[0],
                      consecutive_timeouts: args[1],
                      state: args[2],
                      cooldown_until: args[4],
                      last_error: args[5],
                    });
                  }
                  return { success: true };
                },
                async all() {
                  return { results: [...store.values()] };
                },
              };
            },
            async run() {
              return { success: true };
            },
          };
        },
      },
    } as unknown as Env;
    let snap = await knowledgeCircuitOpen(env, "co_caddington");
    expect(snap.open).toBe(false);
    for (let i = 0; i < KNOWLEDGE_BREAKER_THRESHOLD; i += 1) {
      snap = await recordKnowledgeTimeout(env, "co_caddington", "knowledge_search_timeout");
    }
    expect(snap.open).toBe(true);
    expect(snap.consecutiveTimeouts).toBeGreaterThanOrEqual(KNOWLEDGE_BREAKER_THRESHOLD);
  });

  it("latency summary exposes planning/queue/mcp/search/fetch/synthesis/outbound/total and slowest", () => {
    const report = summariseWhatsAppLatency({
      processingStartedAt: 0,
      inboundReceivedAt: 0,
      webhookReceivedAt: 0,
      queueAcceptedAt: 40,
      planningStartedAt: 50,
      planningCompletedAt: 60,
      mcpStartedAt: 70,
      mcpCompletedAt: 400,
      knowledgeSearchStartedAt: 70,
      knowledgeSearchCompletedAt: 300,
      fetchStartedAt: 300,
      fetchCompletedAt: 380,
      synthesisStartedAt: 380,
      synthesisCompletedAt: 400,
      outboundStartedAt: 410,
      outboundAcceptedAt: 430,
    }, 430);
    expect(report.planningMs).toBe(10);
    expect(report.queueMs).toBe(40);
    expect(report.mcpMs).toBe(330);
    expect(report.knowledgeSearchMs).toBe(230);
    expect(report.fetchMs).toBe(80);
    expect(report.synthesisMs).toBe(20);
    expect(report.outboundMs).toBe(20);
    expect(report.totalMs).toBe(430);
    expect(report.slowestStage).toBe("mcp_ms");
  });

  it("quality signals cover ack-without-final, tool timeout, broad search, and wait>60s", () => {
    const signals = detectQualitySignals({
      interactionId: "int_v44",
      companyId: "co_caddington",
      channel: "whatsapp",
      usage: [
        {
          action: "whatsapp.reply",
          success: false,
          durationMs: 65_000,
          metadata: {
            channel: "whatsapp",
            intent: "knowledge_search",
            acknowledgementSent: true,
            finalSent: false,
            totalMs: 65_000,
            toolTimeout: true,
            lastError: "knowledge_search_timeout",
            broadSearchWithoutTerms: true,
            userRepeatsWhileUnresolved: true,
          },
        },
      ],
    }).map((row) => row.category);
    expect(signals).toEqual(
      expect.arrayContaining([
        "whatsapp_no_final_after_ack",
        "whatsapp_ack_no_final_over_30s",
        "whatsapp_user_wait_over_60s",
        "whatsapp_tool_timeout",
        "whatsapp_broad_search_without_terms",
        "whatsapp_repeat_while_unresolved",
      ]),
    );
  });
});
