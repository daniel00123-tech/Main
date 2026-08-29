import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import whatsappRoutes from "./whatsapp";

const VERIFY = "verify-token-for-tests-32chars-min";

function testEnv(overrides: Partial<Env> = {}): Env {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async run() {
              return { success: true };
            },
            async first() {
              return null;
            },
            async all() {
              return { results: [] };
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
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY,
    WHATSAPP_PHONE_NUMBER_ID: "1338434179351224",
    WHATSAPP_BUSINESS_ACCOUNT_ID: "1629422285251338",
    ...overrides,
  } as Env;
}

function app() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.route("/", whatsappRoutes);
  return hono;
}

describe("WhatsApp webhook routes", () => {
  it("returns the exact Meta challenge on GET verify", async () => {
    const response = await app().request(
      `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=2093840293`,
      { method: "GET" },
      testEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await response.text()).toBe("2093840293");
  });

  it("rejects invalid GET verification", async () => {
    const response = await app().request(
      `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`,
      { method: "GET" },
      testEnv(),
    );
    expect(response.status).toBe(403);
  });

  it("accepts POST quickly without Meta app secret and does not send AI", async () => {
    const response = await app().request(
      "/api/webhooks/whatsapp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          object: "whatsapp_business_account",
          entry: [],
        }),
      },
      testEnv(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; accepted: boolean };
    expect(body.ok).toBe(true);
    expect(body.accepted).toBe(true);
  });

  it("rejects POST when app secret is set and signature is wrong", async () => {
    const response = await app().request(
      "/api/webhooks/whatsapp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": "sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        body: "{}",
      },
      testEnv({ META_APP_SECRET: "configured-secret" }),
    );
    expect(response.status).toBe(403);
  });
});
