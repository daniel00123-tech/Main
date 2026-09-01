import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseWhatsAppInboundMessages,
  verifyWhatsAppHubChallenge,
  verifyWhatsAppSignature,
  whatsappOutboundAiEnabled,
  WHATSAPP_WEBHOOK_PATH,
} from "./whatsapp-webhook";
import type { Env } from "../env";

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    ENVIRONMENT: "test",
    SESSION_SECRET: "test",
    ALLOWED_ORIGINS: "http://localhost:5173",
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-token-for-tests-32chars-min",
    WHATSAPP_PHONE_NUMBER_ID: "1338434179351224",
    WHATSAPP_BUSINESS_ACCOUNT_ID: "1629422285251338",
    ...overrides,
  } as Env;
}

describe("WhatsApp webhook verification", () => {
  it("exposes the production webhook path", () => {
    expect(WHATSAPP_WEBHOOK_PATH).toBe("/api/webhooks/whatsapp");
  });

  it("returns the hub challenge when mode and token match", () => {
    const result = verifyWhatsAppHubChallenge(env(), {
      mode: "subscribe",
      token: "verify-token-for-tests-32chars-min",
      challenge: "1839281923",
    });
    expect(result).toEqual({ ok: true, challenge: "1839281923" });
  });

  it("rejects missing mode, missing challenge, or wrong token", () => {
    expect(
      verifyWhatsAppHubChallenge(env(), {
        mode: "unsubscribe",
        token: "verify-token-for-tests-32chars-min",
        challenge: "1",
      }).ok,
    ).toBe(false);
    expect(
      verifyWhatsAppHubChallenge(env(), {
        mode: "subscribe",
        token: "wrong-token-value-that-does-not-match",
        challenge: "1",
      }).ok,
    ).toBe(false);
    expect(
      verifyWhatsAppHubChallenge(env(), {
        mode: "subscribe",
        token: "verify-token-for-tests-32chars-min",
        challenge: "",
      }).ok,
    ).toBe(false);
  });

  it("fails closed when the verify token secret is missing", () => {
    const result = verifyWhatsAppHubChallenge(env({ WHATSAPP_WEBHOOK_VERIFY_TOKEN: "" }), {
      mode: "subscribe",
      token: "anything",
      challenge: "1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });
});

describe("WhatsApp webhook signature", () => {
  it("accepts a valid X-Hub-Signature-256", async () => {
    const secret = "meta-app-secret-test";
    const body = '{"object":"whatsapp_business_account"}';
    const digest = createHmac("sha256", secret).update(body, "utf8").digest("hex");
    const result = await verifyWhatsAppSignature(env({ META_APP_SECRET: secret }), body, `sha256=${digest}`);
    expect(result).toEqual({ configured: true, valid: true });
  });

  it("rejects a tampered signature when the app secret is configured", async () => {
    const result = await verifyWhatsAppSignature(
      env({ META_APP_SECRET: "meta-app-secret-test" }),
      "{}",
      "sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(result).toEqual({ configured: true, valid: false });
  });

  it("reports signature as unconfigured when META_APP_SECRET is absent", async () => {
    expect(await verifyWhatsAppSignature(env({ META_APP_SECRET: "" }), "{}", "sha256=ab")).toEqual({
      configured: false,
      valid: false,
    });
  });
});

describe("WhatsApp inbound parse and outbound gate", () => {
  it("extracts inbound text messages without exposing extra tenant fields", () => {
    const messages = parseWhatsAppInboundMessages({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1629422285251338",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "1338434179351224" },
                messages: [
                  {
                    id: "wamid.TEST",
                    from: "447700900123",
                    type: "text",
                    timestamp: "1710000000",
                    text: { body: "Hello Infra" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(messages).toEqual([
      {
        wamid: "wamid.TEST",
        from: "447700900123",
        type: "text",
        text: "Hello Infra",
        phoneNumberId: "1338434179351224",
        businessAccountId: "1629422285251338",
        timestamp: "1710000000",
        inputKind: "text",
        mediaId: null,
        mimeType: null,
        buttonId: null,
        buttonTitle: null,
      },
    ]);
  });

  it("keeps outbound AI off until access token, app secret, and explicit flag exist", () => {
    expect(whatsappOutboundAiEnabled(env())).toBe(false);
    expect(
      whatsappOutboundAiEnabled(
        env({
          WHATSAPP_ACCESS_TOKEN: "EAAG-test-token-not-real",
          META_APP_SECRET: "secret-value-present",
        }),
      ),
    ).toBe(false);
    expect(
      whatsappOutboundAiEnabled(
        env({
          WHATSAPP_ACCESS_TOKEN: "EAAG-test-token-not-real",
          META_APP_SECRET: "secret-value-present",
          WHATSAPP_OUTBOUND_AI_ENABLED: "true",
        }),
      ),
    ).toBe(true);
  });
});
