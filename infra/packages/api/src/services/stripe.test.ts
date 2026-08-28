import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createTopUpCheckoutIntent,
  getStripeMode,
  isAllowedTopUpAmountCents,
  processStripeWebhookEvent,
  stripePaymentsAllowed,
  verifyStripeWebhookSignature,
  STRIPE_LIVE_MODE_ALLOWED,
} from "./stripe";
import { DEFAULT_TOP_UP_OPTIONS_CENTS } from "./payment-providers";

vi.mock("./control-plane", () => ({
  recordAuditEvent: vi.fn(async () => undefined),
}));

type Row = Record<string, unknown>;

class FakeStatement {
  constructor(
    private db: FakeD1,
    private sql: string,
    private binds: unknown[] = [],
  ) {}

  bind(...args: unknown[]) {
    return new FakeStatement(this.db, this.sql, args);
  }

  async first() {
    return this.db.first(this.sql, this.binds);
  }

  async all() {
    return { results: this.db.all(this.sql, this.binds) };
  }

  async run() {
    this.db.run(this.sql, this.binds);
    return { success: true };
  }
}

class FakeD1 {
  tables: Record<string, Row[]>;

  constructor(seed: Record<string, Row[]> = {}) {
    this.tables = {
      companies: [
        {
          id: "co_a",
          name: "Tenant A",
          status: "active",
          archived_at: null,
          billing_mode: "test",
        },
        {
          id: "co_b",
          name: "Tenant B",
          status: "suspended",
          archived_at: null,
          billing_mode: "test",
        },
      ],
      stripe_checkout_sessions: [],
      stripe_webhook_events: [],
      ledger_entries: [],
      credit_balances: [{ company_id: "co_a", balance_cents: 0, currency: "GBP", stripe_customer_id: null }],
      payment_provider_accounts: [],
      audit_events: [],
      ...seed,
    };
  }

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  first(sql: string, binds: unknown[]): Row | null {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from companies where id = ?")) {
      return this.tables.companies.find((r) => r.id === binds[0]) ?? null;
    }
    if (q.includes("select billing_mode from companies")) {
      const row = this.tables.companies.find((r) => r.id === binds[0]);
      return row ? { billing_mode: row.billing_mode ?? "test" } : null;
    }
    if (q.includes("from stripe_checkout_sessions where id = ? and company_id = ?")) {
      return (
        this.tables.stripe_checkout_sessions.find(
          (r) => r.id === binds[0] && r.company_id === binds[1],
        ) ?? null
      );
    }
    if (q.includes("from stripe_checkout_sessions where id = ?")) {
      return this.tables.stripe_checkout_sessions.find((r) => r.id === binds[0]) ?? null;
    }
    if (q.includes("from stripe_checkout_sessions where stripe_session_id = ?")) {
      return (
        this.tables.stripe_checkout_sessions.find((r) => r.stripe_session_id === binds[0]) ?? null
      );
    }
    if (q.includes("from stripe_checkout_sessions where stripe_payment_intent_id = ?")) {
      return (
        this.tables.stripe_checkout_sessions.find(
          (r) => r.stripe_payment_intent_id === binds[0],
        ) ?? null
      );
    }
    if (q.includes("from stripe_webhook_events where stripe_event_id = ?")) {
      return this.tables.stripe_webhook_events.find((r) => r.stripe_event_id === binds[0]) ?? null;
    }
    if (q.includes("from ledger_entries") && q.includes("reference_type = ?")) {
      return (
        this.tables.ledger_entries.find(
          (r) =>
            r.company_id === binds[0] &&
            r.reference_type === binds[1] &&
            r.reference_id === binds[2],
        ) ?? null
      );
    }
    if (q.includes("from credit_balances where company_id = ?")) {
      return this.tables.credit_balances.find((r) => r.company_id === binds[0]) ?? null;
    }
    if (q.includes("from payment_provider_accounts")) {
      return (
        this.tables.payment_provider_accounts.find(
          (r) => r.company_id === binds[0] && r.provider === binds[1],
        ) ?? null
      );
    }
    if (q.includes("select coalesce(sum(amount_cents)")) {
      const total = this.tables.ledger_entries
        .filter((r) => r.company_id === binds[0])
        .reduce((sum, r) => sum + Number(r.amount_cents), 0);
      return { total };
    }
    if (q.includes("json_extract(metadata_json, '$.checkoutid')")) {
      const checkoutId = binds[0];
      const total = this.tables.ledger_entries
        .filter(
          (r) =>
            r.entry_type === "refund" &&
            r.reference_type === "stripe_refund" &&
            (() => {
              try {
                const meta = JSON.parse(String(r.metadata_json ?? "{}")) as Record<string, unknown>;
                return meta.checkoutId === checkoutId;
              } catch {
                return false;
              }
            })(),
        )
        .reduce((sum, r) => sum + Math.abs(Number(r.amount_cents)), 0);
      return { total };
    }
    return null;
  }

  all(sql: string, binds: unknown[]): Row[] {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from stripe_checkout_sessions where company_id = ?")) {
      return this.tables.stripe_checkout_sessions.filter((r) => r.company_id === binds[0]);
    }
    return [];
  }

  run(sql: string, binds: unknown[]) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.startsWith("insert into stripe_checkout_sessions")) {
      this.tables.stripe_checkout_sessions.push({
        id: binds[0],
        company_id: binds[1],
        stripe_session_id: binds[2],
        amount_cents: binds[3],
        currency: binds[4],
        status: binds[5],
        created_by: binds[6],
        created_at: binds[7],
        completed_at: binds[8],
        metadata_json: binds[9],
        stripe_mode: binds[10],
        stripe_payment_intent_id: null,
        stripe_customer_id: null,
        credited_at: null,
        failure_reason: null,
      });
    }
    if (q.includes("update stripe_checkout_sessions set stripe_session_id")) {
      const row = this.tables.stripe_checkout_sessions.find((r) => r.id === binds[2]);
      if (row) {
        row.stripe_session_id = binds[0];
        row.stripe_customer_id = binds[1];
        row.status = "checkout_created";
      }
    }
    if (q.includes("update stripe_checkout_sessions set status = 'credited'")) {
      const row = this.tables.stripe_checkout_sessions.find((r) => r.id === binds[4]);
      if (row) {
        row.status = "credited";
        row.completed_at = binds[0];
        row.credited_at = binds[1];
        row.stripe_payment_intent_id = binds[2];
      }
    }
    if (q.includes("update stripe_checkout_sessions set status = 'expired'")) {
      const row = this.tables.stripe_checkout_sessions.find((r) => r.id === binds[0]);
      if (row && row.status !== "credited") row.status = "expired";
    }
    if (q.includes("update stripe_checkout_sessions set status = ?")) {
      const row = this.tables.stripe_checkout_sessions.find((r) => r.id === binds[1]);
      if (row) row.status = binds[0];
    }
    if (q.startsWith("insert into stripe_webhook_events")) {
      this.tables.stripe_webhook_events.push({
        id: binds[0],
        stripe_event_id: binds[1],
        event_type: binds[2],
        processed: binds[3],
        payload_json: binds[4],
        received_at: binds[5],
        processed_at: null,
        error_message: null,
      });
    }
    if (q.includes("update stripe_webhook_events")) {
      const row = this.tables.stripe_webhook_events.find((r) => r.stripe_event_id === binds[2]);
      if (row) {
        row.processed = 1;
        row.processed_at = binds[0];
        if (binds[1]) row.error_message = binds[1];
      }
    }
    if (q.startsWith("insert into ledger_entries")) {
      this.tables.ledger_entries.push({
        id: binds[0],
        company_id: binds[1],
        entry_type: binds[2],
        amount_cents: binds[3],
        currency: binds[4],
        balance_after_cents: binds[5],
        reference_type: binds[6],
        reference_id: binds[7],
        description: binds[8],
        metadata_json: binds[9],
        created_by: binds[10],
        created_at: binds[11],
      });
    }
    if (q.startsWith("insert or ignore into credit_balances")) {
      if (!this.tables.credit_balances.find((r) => r.company_id === binds[0])) {
        this.tables.credit_balances.push({
          company_id: binds[0],
          balance_cents: binds[1],
          currency: binds[2],
        });
      }
    }
    if (q.includes("update credit_balances set balance_cents")) {
      const row = this.tables.credit_balances.find((r) => r.company_id === binds[2]);
      if (row) row.balance_cents = binds[0];
    }
  }
}

const testEnv = {
  DB: new FakeD1() as unknown as D1Database,
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
  ENVIRONMENT: "test",
  SESSION_SECRET: "test-secret",
  ALLOWED_ORIGINS: "https://test",
} as import("../env").Env;

describe("stripe mode detection", () => {
  it("detects test mode from sk_test key", () => {
    expect(getStripeMode(testEnv)).toBe("test");
    expect(stripePaymentsAllowed(testEnv)).toBe(true);
  });

  it("blocks live mode when not allowed", () => {
    const liveEnv = { ...testEnv, STRIPE_SECRET_KEY: "sk_live_fake" };
    expect(getStripeMode(liveEnv)).toBe("live");
    expect(STRIPE_LIVE_MODE_ALLOWED).toBe(false);
    expect(stripePaymentsAllowed(liveEnv)).toBe(false);
  });
});

describe("top-up amount whitelist", () => {
  it("allows preset amounts only", () => {
    for (const amount of DEFAULT_TOP_UP_OPTIONS_CENTS) {
      expect(isAllowedTopUpAmountCents(amount, testEnv)).toBe(true);
    }
    expect(isAllowedTopUpAmountCents(1500, testEnv)).toBe(false);
    expect(isAllowedTopUpAmountCents(999999, testEnv)).toBe(false);
  });

  it("allows £1 sandbox amount in Stripe test mode", () => {
    expect(isAllowedTopUpAmountCents(100, testEnv)).toBe(true);
    const liveEnv = { ...testEnv, STRIPE_SECRET_KEY: "sk_live_fake" } as import("../env").Env;
    expect(isAllowedTopUpAmountCents(100, liveEnv)).toBe(false);
  });
});

describe("createTopUpCheckoutIntent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects tampered amounts", async () => {
    const result = await createTopUpCheckoutIntent(testEnv, {
      companyId: "co_a",
      companyName: "Tenant A",
      amountCents: 1500,
      createdBy: "user@test.com",
      successUrl: "https://app.test/billing?topup=success",
      cancelUrl: "https://app.test/billing?topup=cancelled",
    });
    expect(result.configured).toBe(false);
    if (!result.configured) expect(result.code).toBe("INVALID_AMOUNT");
  });

  it("rejects suspended companies", async () => {
    const result = await createTopUpCheckoutIntent(testEnv, {
      companyId: "co_b",
      companyName: "Tenant B",
      amountCents: 1000,
      createdBy: "user@test.com",
      successUrl: "https://app.test/billing?topup=success",
      cancelUrl: "https://app.test/billing?topup=cancelled",
    });
    expect(result.configured).toBe(false);
    if (!result.configured) expect(result.code).toBe("COMPANY_SUSPENDED");
  });

  it("returns pending_credentials without Stripe API call", async () => {
    const env = { ...testEnv, DB: testEnv.DB, STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined } as import("../env").Env;
    const result = await createTopUpCheckoutIntent(env, {
      companyId: "co_a",
      companyName: "Tenant A",
      amountCents: 1000,
      createdBy: "user@test.com",
      successUrl: "https://app.test/billing?topup=success",
      cancelUrl: "https://app.test/billing?topup=cancelled",
    });
    expect(result.configured).toBe(true);
    if (result.configured) expect(result.mode).toBe("pending_credentials");
  });

  it("blocks live checkout for test billing company on live platform", async () => {
    const liveEnv = {
      ...testEnv,
      STRIPE_SECRET_KEY: "sk_live_acceptance",
      STRIPE_WEBHOOK_SECRET: "whsec_live",
    } as import("../env").Env;
    const result = await createTopUpCheckoutIntent(liveEnv, {
      companyId: "co_a",
      companyName: "Tenant A",
      amountCents: 500,
      createdBy: "user@test.com",
      successUrl: "https://app.test/billing?topup=success",
      cancelUrl: "https://app.test/billing?topup=cancelled",
    });
    expect(result.configured).toBe(false);
    if (!result.configured) {
      expect(result.code).toBe("BILLING_MODE_BLOCKED");
      expect(result.error).toContain("billing mode is test");
    }
  });
});

describe("processStripeWebhookEvent", () => {
  const checkoutId = "stripe_co_test";
  const companyId = "co_a";

  beforeEach(() => {
    (testEnv.DB as unknown as FakeD1).tables.stripe_checkout_sessions = [
      {
        id: checkoutId,
        company_id: companyId,
        stripe_session_id: "cs_test_123",
        amount_cents: 2500,
        currency: "GBP",
        status: "checkout_created",
        created_by: "user@test.com",
        created_at: new Date().toISOString(),
        completed_at: null,
        metadata_json: "{}",
        stripe_mode: "test",
        stripe_payment_intent_id: null,
        stripe_customer_id: null,
        credited_at: null,
        failure_reason: null,
      },
    ];
    (testEnv.DB as unknown as FakeD1).tables.stripe_webhook_events = [];
    (testEnv.DB as unknown as FakeD1).tables.ledger_entries = [];
  });

  it("credits ledger once on checkout.session.completed", async () => {
    const payload = {
      data: {
        object: {
          id: "cs_test_123",
          payment_status: "paid",
          client_reference_id: checkoutId,
          metadata: { company_id: companyId, infra_checkout_id: checkoutId },
          amount_total: 2500,
          currency: "gbp",
          payment_intent: "pi_test_123",
        },
      },
    };

    const first = await processStripeWebhookEvent(testEnv, {
      stripeEventId: "evt_1",
      eventType: "checkout.session.completed",
      payload,
    });
    expect(first.processed).toBe(true);

    const second = await processStripeWebhookEvent(testEnv, {
      stripeEventId: "evt_1",
      eventType: "checkout.session.completed",
      payload,
    });
    expect(second.duplicate).toBe(true);

    const ledger = (testEnv.DB as unknown as FakeD1).tables.ledger_entries;
    expect(ledger.length).toBe(1);
    expect(ledger[0]?.amount_cents).toBe(2500);
    expect(ledger[0]?.entry_type).toBe("top_up");
  });

  it("rejects company mismatch", async () => {
    const result = await processStripeWebhookEvent(testEnv, {
      stripeEventId: "evt_mismatch",
      eventType: "checkout.session.completed",
      payload: {
        data: {
          object: {
            id: "cs_test_123",
            payment_status: "paid",
            client_reference_id: checkoutId,
            metadata: { company_id: "co_other", infra_checkout_id: checkoutId },
            amount_total: 2500,
            currency: "gbp",
          },
        },
      },
    });
    expect(result.code).toBe("COMPANY_MISMATCH");
    expect((testEnv.DB as unknown as FakeD1).tables.ledger_entries.length).toBe(0);
  });

  it("rejects amount mismatch", async () => {
    const result = await processStripeWebhookEvent(testEnv, {
      stripeEventId: "evt_amount",
      eventType: "checkout.session.completed",
      payload: {
        data: {
          object: {
            id: "cs_test_123",
            payment_status: "paid",
            client_reference_id: checkoutId,
            metadata: { company_id: companyId, infra_checkout_id: checkoutId },
            amount_total: 100,
            currency: "gbp",
          },
        },
      },
    });
    expect(result.code).toBe("AMOUNT_MISMATCH");
  });

  it("rejects unpaid checkout sessions", async () => {
    const result = await processStripeWebhookEvent(testEnv, {
      stripeEventId: "evt_unpaid",
      eventType: "checkout.session.completed",
      payload: {
        data: {
          object: {
            id: "cs_test_123",
            payment_status: "unpaid",
            client_reference_id: checkoutId,
            metadata: { company_id: companyId },
          },
        },
      },
    });
    expect(result.code).toBe("NOT_PAID");
  });

  it("records refund without double-crediting", async () => {
    (testEnv.DB as unknown as FakeD1).tables.stripe_checkout_sessions[0]!.status = "credited";
    (testEnv.DB as unknown as FakeD1).tables.stripe_checkout_sessions[0]!.stripe_payment_intent_id =
      "pi_test_123";
    (testEnv.DB as unknown as FakeD1).tables.ledger_entries.push({
      id: "ledger_1",
      company_id: companyId,
      entry_type: "top_up",
      amount_cents: 2500,
      currency: "GBP",
      balance_after_cents: 2500,
      reference_type: "stripe_checkout",
      reference_id: checkoutId,
      description: "top up",
      metadata_json: "{}",
      created_by: "stripe-webhook",
      created_at: new Date().toISOString(),
    });

    const first = await processStripeWebhookEvent(testEnv, {
      stripeEventId: "evt_refund_1",
      eventType: "charge.refunded",
      payload: {
        data: {
          object: {
            id: "ch_test",
            payment_intent: "pi_test_123",
            amount_refunded: 2500,
          },
        },
      },
    });
    expect(first.processed).toBe(true);

    const second = await processStripeWebhookEvent(testEnv, {
      stripeEventId: "evt_refund_1",
      eventType: "charge.refunded",
      payload: {
        data: {
          object: {
            id: "ch_test",
            payment_intent: "pi_test_123",
            amount_refunded: 2500,
          },
        },
      },
    });
    expect(second.duplicate).toBe(true);

    const refunds = (testEnv.DB as unknown as FakeD1).tables.ledger_entries.filter(
      (r) => r.entry_type === "refund",
    );
    expect(refunds.length).toBe(1);
    expect(refunds[0]?.amount_cents).toBe(-2500);
  });

  it("allows refund ledger debit when paid credit was already consumed", async () => {
    (testEnv.DB as unknown as FakeD1).tables.stripe_checkout_sessions[0]!.status = "credited";
    (testEnv.DB as unknown as FakeD1).tables.stripe_checkout_sessions[0]!.stripe_payment_intent_id =
      "pi_test_123";
    (testEnv.DB as unknown as FakeD1).tables.credit_balances[0]!.balance_cents = 100;
    (testEnv.DB as unknown as FakeD1).tables.ledger_entries.push({
      id: "ledger_topup",
      company_id: companyId,
      entry_type: "top_up",
      amount_cents: 2500,
      currency: "GBP",
      balance_after_cents: 2500,
      reference_type: "stripe_checkout",
      reference_id: checkoutId,
      description: "top up",
      metadata_json: "{}",
      created_by: "stripe-webhook",
      created_at: new Date().toISOString(),
    });
    (testEnv.DB as unknown as FakeD1).tables.ledger_entries.push({
      id: "ledger_usage",
      company_id: companyId,
      entry_type: "usage_debit",
      amount_cents: -2400,
      currency: "GBP",
      balance_after_cents: 100,
      reference_type: "usage",
      reference_id: "usage_1",
      description: "usage",
      metadata_json: "{}",
      created_by: "system",
      created_at: new Date().toISOString(),
    });

    const result = await processStripeWebhookEvent(testEnv, {
      stripeEventId: "evt_refund_spent",
      eventType: "charge.refunded",
      payload: {
        data: {
          object: {
            id: "ch_test",
            payment_intent: "pi_test_123",
            amount_refunded: 2500,
          },
        },
      },
    });

    expect(result.processed).toBe(true);
    expect((testEnv.DB as unknown as FakeD1).tables.credit_balances[0]?.balance_cents).toBe(-2400);
  });

  it("records incremental partial refunds from cumulative charge.refunded amounts", async () => {
    (testEnv.DB as unknown as FakeD1).tables.stripe_checkout_sessions[0]!.status = "credited";
    (testEnv.DB as unknown as FakeD1).tables.stripe_checkout_sessions[0]!.stripe_payment_intent_id =
      "pi_test_123";
    (testEnv.DB as unknown as FakeD1).tables.stripe_checkout_sessions[0]!.amount_cents = 10000;

    const first = await processStripeWebhookEvent(testEnv, {
      stripeEventId: "evt_partial_1",
      eventType: "charge.refunded",
      payload: {
        data: {
          object: {
            id: "ch_test",
            payment_intent: "pi_test_123",
            amount_refunded: 2000,
          },
        },
      },
    });
    expect(first.processed).toBe(true);

    const second = await processStripeWebhookEvent(testEnv, {
      stripeEventId: "evt_partial_2",
      eventType: "charge.refunded",
      payload: {
        data: {
          object: {
            id: "ch_test",
            payment_intent: "pi_test_123",
            amount_refunded: 5000,
          },
        },
      },
    });
    expect(second.processed).toBe(true);

    const refunds = (testEnv.DB as unknown as FakeD1).tables.ledger_entries.filter(
      (r) => r.entry_type === "refund",
    );
    expect(refunds).toHaveLength(2);
    expect(refunds[0]?.amount_cents).toBe(-2000);
    expect(refunds[1]?.amount_cents).toBe(-3000);
  });

  it("marks checkout expired without crediting wallet", async () => {
    const result = await processStripeWebhookEvent(testEnv, {
      stripeEventId: "evt_expired",
      eventType: "checkout.session.expired",
      payload: {
        data: {
          object: {
            id: "cs_test_123",
            client_reference_id: checkoutId,
            metadata: { company_id: companyId, infra_checkout_id: checkoutId },
          },
        },
      },
    });
    expect(result.processed).toBe(true);
    expect((testEnv.DB as unknown as FakeD1).tables.stripe_checkout_sessions[0]?.status).toBe(
      "expired",
    );
    expect((testEnv.DB as unknown as FakeD1).tables.ledger_entries.length).toBe(0);
  });

  it("rejects currency mismatch", async () => {
    const result = await processStripeWebhookEvent(testEnv, {
      stripeEventId: "evt_currency",
      eventType: "checkout.session.completed",
      payload: {
        data: {
          object: {
            id: "cs_test_123",
            payment_status: "paid",
            client_reference_id: checkoutId,
            metadata: { company_id: companyId, infra_checkout_id: checkoutId },
            amount_total: 2500,
            currency: "usd",
          },
        },
      },
    });
    expect(result.code).toBe("CURRENCY_MISMATCH");
  });
});

describe("verifyStripeWebhookSignature", () => {
  it("rejects missing signature", async () => {
    expect(await verifyStripeWebhookSignature(testEnv, "{}", null)).toBe(false);
  });

  it("rejects stale timestamps", async () => {
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    expect(
      await verifyStripeWebhookSignature(testEnv, "{}", `t=${oldTs},v1=deadbeef`),
    ).toBe(false);
  });

  it("accepts valid signature", async () => {
    const payload = '{"id":"evt_test"}';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(testEnv.STRIPE_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${payload}`),
    );
    const sig = Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(
      await verifyStripeWebhookSignature(testEnv, payload, `t=${timestamp},v1=${sig}`),
    ).toBe(true);
  });
});
