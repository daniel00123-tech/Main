import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID, INFRA_WHATSAPP_PHONE_NUMBER_ID } from "./whatsapp-assets";
import {
  inspectWhatsAppCloudRegistration,
  registerWhatsAppCloudPhoneNumber,
  resolveWhatsAppRegistrationPin,
  WHATSAPP_PIN_USER_ACTION,
  WHATSAPP_REGISTER_GRAPH_VERSION,
} from "./whatsapp-register";

const TOKEN = "EAAG-test-token-not-real";

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    ENVIRONMENT: "test",
    SESSION_SECRET: "test",
    ALLOWED_ORIGINS: "http://localhost:5173",
    WHATSAPP_PHONE_NUMBER_ID: INFRA_WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_BUSINESS_ACCOUNT_ID: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
    WHATSAPP_ACCESS_TOKEN: TOKEN,
    META_APP_SECRET: "meta-app-secret-for-tests-only",
    WHATSAPP_OUTBOUND_AI_ENABLED: "true",
    ...overrides,
  } as Env;
}

describe("WhatsApp Cloud registration PIN", () => {
  it("does not invent a PIN when none is configured", () => {
    expect(resolveWhatsAppRegistrationPin(env())).toEqual({
      ok: false,
      userActionRequired: WHATSAPP_PIN_USER_ACTION,
    });
    expect(resolveWhatsAppRegistrationPin(env(), "12")).toEqual({
      ok: false,
      userActionRequired: WHATSAPP_PIN_USER_ACTION,
    });
    expect(resolveWhatsAppRegistrationPin(env(), "abcdef")).toEqual({
      ok: false,
      userActionRequired: WHATSAPP_PIN_USER_ACTION,
    });
  });

  it("accepts a six-digit request PIN or a configured secret", () => {
    expect(resolveWhatsAppRegistrationPin(env(), "246813")).toEqual({
      ok: true,
      source: "request",
      pin: "246813",
    });
    expect(resolveWhatsAppRegistrationPin(env({ WHATSAPP_REGISTRATION_PIN: "975310" }))).toEqual({
      ok: true,
      source: "secret",
      pin: "975310",
    });
  });
});

describe("WhatsApp Cloud inspect", () => {
  it("confirms the real WABA and phone number without leaking the token", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`${INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID}/phone_numbers`)) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: [
                {
                  id: INFRA_WHATSAPP_PHONE_NUMBER_ID,
                  display_phone_number: "+44 7466 227958",
                  status: "PENDING",
                  code_verification_status: "VERIFIED",
                },
              ],
            }),
        };
      }
      if (url.includes(INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID) && !url.includes("phone_numbers")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID, name: "Infra" }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: INFRA_WHATSAPP_PHONE_NUMBER_ID,
            display_phone_number: "+44 7466 227958",
            status: "PENDING",
            code_verification_status: "VERIFIED",
            verified_name: "Infra",
          }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await inspectWhatsAppCloudRegistration(env());
    expect(result.tokenHasAccessToWaba).toBe(true);
    expect(result.phoneNumberIdConfirmed).toBe(true);
    expect(result.phoneNumberId).toBe(INFRA_WHATSAPP_PHONE_NUMBER_ID);
    expect(result.businessAccountId).toBe(INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID);
    expect(result.looksLikeSandbox).toBe(false);
    expect(result.metaStatus).toBe("PENDING");
    expect(result.registered).toBe(false);
    expect(result.pinRequired).toBe(true);
    expect(result.userActionRequired).toBe(WHATSAPP_PIN_USER_ACTION);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(WHATSAPP_REGISTER_GRAPH_VERSION);
    vi.unstubAllGlobals();
  });
});

describe("WhatsApp Cloud register", () => {
  it("refuses to call Meta when no valid PIN is known", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await registerWhatsAppCloudPhoneNumber(env(), "");
    expect(result.attempted).toBe(false);
    expect(result.success).toBe(false);
    expect(result.userActionRequired).toBe(WHATSAPP_PIN_USER_ACTION);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("refuses sandbox phone numbers even if a PIN is supplied", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await registerWhatsAppCloudPhoneNumber(
      env({
        WHATSAPP_PHONE_NUMBER_ID: "15550001111",
        WHATSAPP_BUSINESS_ACCOUNT_ID: "5550001111",
      }),
      "123456",
    );
    expect(result.attempted).toBe(false);
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("registers only the production phone number and redacts token material", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/register")) {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body ?? "{}")) as { messaging_product?: string; pin?: string };
        expect(body).toEqual({ messaging_product: "whatsapp", pin: "246810" });
        expect(String(init?.headers)).not.toContain("246810");
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
      }
      if (url.includes(`${INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID}/phone_numbers`)) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: [{ id: INFRA_WHATSAPP_PHONE_NUMBER_ID, status: "CONNECTED" }],
            }),
        };
      }
      if (url.includes(INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID) && !url.includes("/register")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: INFRA_WHATSAPP_PHONE_NUMBER_ID,
            status: "CONNECTED",
            code_verification_status: "VERIFIED",
            display_phone_number: "+44 7466 227958",
          }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await registerWhatsAppCloudPhoneNumber(env(), "246810");
    expect(result.attempted).toBe(true);
    expect(result.success).toBe(true);
    expect(result.inspect.registered).toBe(true);
    expect(result.inspect.metaStatus).toBe("CONNECTED");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("246810");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/deregister"))).toBe(false);
    vi.unstubAllGlobals();
  });
});
