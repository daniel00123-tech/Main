import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID, INFRA_WHATSAPP_PHONE_NUMBER_ID } from "./whatsapp-assets";
import { classifyWhatsAppOutbound, sendWhatsAppInteractiveButtons, sendWhatsAppText } from "./whatsapp-send";

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    ENVIRONMENT: "test",
    SESSION_SECRET: "test",
    ALLOWED_ORIGINS: "http://localhost:5173",
    WHATSAPP_PHONE_NUMBER_ID: INFRA_WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_BUSINESS_ACCOUNT_ID: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
    WHATSAPP_ACCESS_TOKEN: "EAAG-test-token-not-real",
    META_APP_SECRET: "meta-app-secret-for-tests-only",
    WHATSAPP_OUTBOUND_AI_ENABLED: "true",
    ...overrides,
  } as Env;
}

describe("WhatsApp outbound send", () => {
  it("distinguishes customer-service replies from template sends", () => {
    expect(classifyWhatsAppOutbound({ inCustomerServiceWindow: true })).toBe("customer_service_reply");
    expect(classifyWhatsAppOutbound({ inCustomerServiceWindow: false, templateName: "hello" })).toBe(
      "business_initiated_template",
    );
  });

  it("refuses free-form messages outside the customer-service window", async () => {
    const result = await sendWhatsAppText(env(), {
      toE164: "+447700900123",
      body: "hello",
      inCustomerServiceWindow: false,
    });
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("customer_service_reply");
  });

  it("retries retryable Meta failures and never leaks the access token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Bearer EAAG-test-token-not-real boom" })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ messages: [{ id: "wamid.OUT" }] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendWhatsAppText(env(), {
      toE164: "+447700900123",
      body: "hello",
      inCustomerServiceWindow: true,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(JSON.stringify(result)).not.toContain("EAAG-test-token-not-real");
    vi.unstubAllGlobals();
  });

  it("sends at most three reply buttons and falls back to text when none are attachable", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ messages: [{ id: "wamid.BTN" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendWhatsAppInteractiveButtons(env(), {
      toE164: "+447700900123",
      body: "I found Coal Search.pdf 📄",
      buttons: [
        { id: "summarise", title: "Summarise" },
        { id: "open_source", title: "Open source" },
        { id: "more_detail", title: "More detail" },
      ],
      inCustomerServiceWindow: true,
    });
    expect(result.ok).toBe(true);
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as {
      type?: string;
      interactive?: { action?: { buttons?: unknown[] } };
    };
    expect(payload.type).toBe("interactive");
    expect(payload.interactive?.action?.buttons).toHaveLength(3);
    vi.unstubAllGlobals();
  });
});
