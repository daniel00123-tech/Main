import { describe, expect, it, vi } from "vitest";
import {
  acquireWhatsAppChatLock,
  CHAT_LOCK_TTL_MS,
  releaseWhatsAppChatLock,
} from "./whatsapp-chat-lock";
import { WATCHDOG_STILL_WORKING_COPY, isWhatsAppFastLaneText } from "./whatsapp-fast-lane";
import { applyWhatsAppWatchdogStage } from "./whatsapp-reaper";
import { WHATSAPP_PRODUCTION_WEBHOOK_URL } from "./whatsapp-subscription";
import type { Env } from "../env";

function lockEnv(rows: Map<string, { wamid: string; expires_at: string }>): Env {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes("FROM whatsapp_chat_locks")) {
                  return rows.get(String(args[0])) ?? null;
                }
                return null;
              },
              async run() {
                if (sql.includes("INSERT INTO whatsapp_chat_locks")) {
                  rows.set(String(args[0]), {
                    wamid: String(args[1]),
                    expires_at: String(args[3]),
                  });
                }
                if (sql.includes("UPDATE whatsapp_chat_locks")) {
                  rows.set(String(args[3]), {
                    wamid: String(args[0]),
                    expires_at: String(args[2]),
                  });
                }
                if (sql.includes("DELETE FROM whatsapp_chat_locks")) {
                  const current = rows.get(String(args[0]));
                  if (current?.wamid === args[1]) rows.delete(String(args[0]));
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
    },
  } as unknown as Env;
}

describe("WhatsApp V4.3 independent watchdog and chat lock", () => {
  it("keeps the 10s still-working copy without changing greeting wording", () => {
    expect(WATCHDOG_STILL_WORKING_COPY).toBe("Got it 👍 I’m still working on that.");
    expect(isWhatsAppFastLaneText("hi")).toBe(true);
    expect(isWhatsAppFastLaneText("can you find me a doc or two on the system and tell me about it")).toBe(false);
  });

  it("uses the production webhook URL for Cloud API override", () => {
    expect(WHATSAPP_PRODUCTION_WEBHOOK_URL).toBe("https://api.infrastack.app/api/webhooks/whatsapp");
  });

  it("chat lock expires and fail-opens instead of blocking a later greeting", async () => {
    const rows = new Map<string, { wamid: string; expires_at: string }>();
    const env = lockEnv(rows);
    const first = await acquireWhatsAppChatLock(env, {
      chatKey: "+447932609444",
      wamid: "wamid.one",
      ttlMs: CHAT_LOCK_TTL_MS,
    });
    expect(first.acquired).toBe(true);
    rows.set("+447932609444", {
      wamid: "wamid.one",
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    const greeting = await acquireWhatsAppChatLock(env, {
      chatKey: "+447932609444",
      wamid: "wamid.hi",
      failOpen: true,
    });
    expect(greeting.acquired || greeting.failOpen || greeting.expired).toBe(true);
    await releaseWhatsAppChatLock(env, { chatKey: "+447932609444", wamid: "wamid.hi" });
  });

  it("held lock does not wait — greeting fail-open continues", async () => {
    const rows = new Map<string, { wamid: string; expires_at: string }>();
    rows.set("+447932609444", {
      wamid: "wamid.busy",
      expires_at: new Date(Date.now() + 8_000).toISOString(),
    });
    const result = await acquireWhatsAppChatLock(lockEnv(rows), {
      chatKey: "+447932609444",
      wamid: "wamid.hi2",
      failOpen: true,
    });
    expect(result.acquired).toBe(false);
    expect(result.failOpen).toBe(true);
  });

  it("watchdog that arrives early requeues instead of sleeping in the consumer", async () => {
    const sent: Array<{ delaySeconds?: number }> = [];
    const env = {
      WHATSAPP_WATCHDOG_QUEUE: {
        async send(_message: unknown, options?: { delaySeconds?: number }) {
          sent.push(options ?? {});
        },
      },
      DB: {
        prepare() {
          return {
            bind() {
              return this;
            },
            async first() {
              return null;
            },
            async run() {
              return { success: true };
            },
          };
        },
      },
    } as unknown as Env;
    const result = await applyWhatsAppWatchdogStage(env, {
      eventId: "wa_evt_early",
      wamid: "wamid.HBgNexample",
      stage: "t10",
      receivedAt: new Date().toISOString(),
    });
    expect(result.reason).toBe("requeued");
    expect(sent[0]?.delaySeconds).toBeGreaterThanOrEqual(1);
  });
});
