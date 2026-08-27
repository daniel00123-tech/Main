import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { app } from "../index";
import phase3Source from "../routes/phase3.ts?raw";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "../..");
const webApiSource = readFileSync(
  join(apiDir, "../web/src/api.ts"),
  "utf8",
);
const portalBillingSource = readFileSync(
  join(apiDir, "../web/src/portal/PortalBillingPage.tsx"),
  "utf8",
);

function minimalMockDb(): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
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
      };
    },
  } as unknown as D1Database;
}

const CUSTOMER_REFUND_PATHS = [
  "/api/companies/demo/wallet/refund",
  "/api/companies/demo/wallet/refunds",
  "/api/companies/demo/wallet/request-refund",
  "/api/companies/demo/refund",
  "/api/stripe/refund",
  "/api/stripe/refunds",
];

describe("admin-only refund policy", () => {
  it("does not register customer-accessible refund API routes in phase3", () => {
    const walletRoutes = [...phase3Source.matchAll(/phase3\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g)].map(
      (match) => match[2],
    );
    const refundRoutes = walletRoutes.filter((route) => /refund/i.test(route));
    expect(refundRoutes).toEqual([]);
  });

  it("does not expose refund client methods in the portal API wrapper", () => {
    expect(webApiSource).not.toMatch(/\brefund\b/i);
    expect(webApiSource).not.toMatch(/wallet\/refund/i);
  });

  it("does not render self-service refund actions in the billing portal", () => {
    expect(portalBillingSource).not.toMatch(/Request Refund/i);
    expect(portalBillingSource).not.toMatch(/>\s*Refund\s*</);
    expect(portalBillingSource).not.toMatch(/wallet\/refund/i);
  });

  it("returns 404 for hypothetical customer refund endpoints", async () => {
    for (const path of CUSTOMER_REFUND_PATHS) {
      const response = await app.request(
        path,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amountCents: 1000 }),
        },
        {
          DB: minimalMockDb(),
          ENVIRONMENT: "development",
          SESSION_SECRET: "test-session-secret-at-least-32-characters",
          ALLOWED_ORIGINS: "http://localhost:5173",
          STRIPE_SECRET_KEY: "sk_test_example",
          STRIPE_WEBHOOK_SECRET: "whsec_example",
        },
      );
      expect(response.status, path).toBe(404);
    }
  });

  it("rejects unsigned Stripe webhook refund attempts (no customer-initiated refund path)", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return null;
              },
              async run() {
                return { success: true };
              },
            };
          },
        };
      },
    };

    const response = await app.request(
      "/api/stripe/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": "t=0,v1=deadbeef",
        },
        body: JSON.stringify({
          id: "evt_refund_attempt",
          type: "charge.refunded",
          data: { object: { payment_intent: "pi_fake", amount_refunded: 1000 } },
        }),
      },
      {
        DB: db as unknown as D1Database,
        ENVIRONMENT: "development",
        SESSION_SECRET: "test-session-secret-at-least-32-characters",
        ALLOWED_ORIGINS: "http://localhost:5173",
        STRIPE_SECRET_KEY: "sk_test_example",
        STRIPE_WEBHOOK_SECRET: "whsec_example",
      },
    );
    expect(response.status).toBe(400);
  });
});
