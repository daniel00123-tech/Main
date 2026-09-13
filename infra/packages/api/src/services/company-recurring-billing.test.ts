import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  cancelCompanyRecurringCharge,
  createCompanyRecurringCharge,
  listCompanyRecurringCharges,
  listRecurringBillingCompanies,
  processRecurringCompanyBillingWebhook,
} from "./company-recurring-billing";
import { requirePlatformAdmin } from "../auth/middleware";
import type { Env } from "../env";

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
  tables: Record<string, Row[]> = {
    companies: [
      {
        id: "co_el",
        name: "EL Business",
        slug: "el-business",
        status: "active",
        archived_at: null,
        currency: "GBP",
        billing_mode: "test",
      },
    ],
    credit_balances: [
      {
        company_id: "co_el",
        balance_cents: 0,
        currency: "GBP",
        updated_at: "2026-09-13T00:00:00.000Z",
        stripe_customer_id: "cus_el",
      },
    ],
    payment_provider_accounts: [
      {
        id: "pay_el",
        company_id: "co_el",
        provider: "stripe",
        external_customer_ref: "cus_el",
        payment_method_id: "pm_card",
        payment_method_status: "active",
        payment_method_brand: "visa",
        payment_method_last4: "4242",
        payment_method_exp_month: 12,
        payment_method_exp_year: 2030,
      },
    ],
    company_recurring_charges: [],
    audit_events: [],
  };

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  companyWithProvider(companyId: unknown): Row | null {
    const company = this.tables.companies.find((row) => row.id === companyId);
    if (!company) return null;
    const balance = this.tables.credit_balances.find((row) => row.company_id === companyId) ?? {};
    const provider =
      this.tables.payment_provider_accounts.find(
        (row) => row.company_id === companyId && row.provider === "stripe",
      ) ?? {};
    return {
      ...provider,
      ...balance,
      ...company,
      stripe_customer_id: balance.stripe_customer_id,
      external_customer_ref: provider.external_customer_ref,
      payment_method_id: provider.payment_method_id,
      payment_method_brand: provider.payment_method_brand,
      payment_method_last4: provider.payment_method_last4,
      payment_method_exp_month: provider.payment_method_exp_month,
      payment_method_exp_year: provider.payment_method_exp_year,
      payment_method_status: provider.payment_method_status,
    };
  }

  chargeWithCompany(charge: Row): Row {
    const company = this.tables.companies.find((row) => row.id === charge.company_id) ?? {};
    const provider =
      this.tables.payment_provider_accounts.find(
        (row) => row.company_id === charge.company_id && row.provider === "stripe",
      ) ?? {};
    return {
      ...charge,
      company_name: company.name,
      company_slug: company.slug,
      payment_method_brand: provider.payment_method_brand,
      payment_method_last4: provider.payment_method_last4,
    };
  }

  first(sql: string, binds: unknown[]): Row | null {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from companies c") && q.includes("left join payment_provider_accounts") && q.includes("where c.id = ?")) {
      return this.companyWithProvider(binds[0]);
    }
    if (q.includes("select billing_mode from companies")) {
      const company = this.tables.companies.find((row) => row.id === binds[0]);
      return company ? { billing_mode: company.billing_mode } : null;
    }
    if (q.includes("select stripe_customer_id from credit_balances")) {
      return this.tables.credit_balances.find((row) => row.company_id === binds[0]) ?? null;
    }
    if (q.includes("select external_customer_ref from payment_provider_accounts")) {
      return (
        this.tables.payment_provider_accounts.find(
          (row) => row.company_id === binds[0] && row.provider === "stripe",
        ) ?? null
      );
    }
    if (q.includes("select payment_method_id") && q.includes("from payment_provider_accounts")) {
      return (
        this.tables.payment_provider_accounts.find(
          (row) => row.company_id === binds[0] && row.provider === "stripe",
        ) ?? null
      );
    }
    if (q.includes("from company_recurring_charges crc") && q.includes("where crc.id = ?")) {
      const charge = this.tables.company_recurring_charges.find((row) => row.id === binds[0]);
      return charge ? this.chargeWithCompany(charge) : null;
    }
    if (q.includes("select id from company_recurring_charges where stripe_subscription_id = ?")) {
      const charge = this.tables.company_recurring_charges.find(
        (row) => row.stripe_subscription_id === binds[0],
      );
      return charge ? { id: charge.id } : null;
    }
    return null;
  }

  all(sql: string, _binds: unknown[] = []): Row[] {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from companies c") && q.includes("order by c.name asc")) {
      return this.tables.companies
        .filter((company) => !company.archived_at)
        .map((company) => this.companyWithProvider(company.id)!)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
    if (q.includes("from company_recurring_charges crc")) {
      return this.tables.company_recurring_charges.map((charge) =>
        this.chargeWithCompany(charge),
      );
    }
    return [];
  }

  run(sql: string, binds: unknown[]) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.startsWith("insert or ignore into payment_provider_accounts")) {
      const existing = this.tables.payment_provider_accounts.find(
        (row) => row.company_id === binds[1] && row.provider === binds[2],
      );
      if (!existing) {
        this.tables.payment_provider_accounts.push({
          id: binds[0],
          company_id: binds[1],
          provider: binds[2],
          status: "not_configured",
          metadata_json: "{}",
          created_at: binds[3],
          updated_at: binds[4],
        });
      }
    }
    if (q.includes("update payment_provider_accounts") && q.includes("external_customer_ref = coalesce")) {
      const provider = this.tables.payment_provider_accounts.find(
        (row) => row.company_id === binds[2] && row.provider === "stripe",
      );
      if (provider && !provider.external_customer_ref) provider.external_customer_ref = binds[0];
    }
    if (q.startsWith("insert into company_recurring_charges")) {
      this.tables.company_recurring_charges.push({
        id: binds[0],
        company_id: binds[1],
        stripe_subscription_id: null,
        stripe_product_id: null,
        stripe_price_id: null,
        stripe_customer_id: binds[2],
        stripe_payment_method_id: binds[3],
        amount_cents: binds[4],
        currency: binds[5],
        interval: binds[6],
        description: binds[7],
        status: "creating",
        failure_reason: null,
        created_by: binds[8],
        created_at: binds[9],
        updated_at: binds[10],
        canceled_by: null,
        canceled_at: null,
        last_invoice_id: null,
        last_invoice_status: null,
        last_invoice_at: null,
        metadata_json: binds[11],
      });
    }
    if (q.includes("set stripe_subscription_id = ?")) {
      const charge = this.tables.company_recurring_charges.find((row) => row.id === binds[6]);
      if (charge) {
        charge.stripe_subscription_id = binds[0];
        charge.stripe_product_id = binds[1];
        charge.stripe_price_id = binds[2];
        charge.status = binds[3];
        charge.updated_at = binds[4];
        charge.last_invoice_id = binds[5];
      }
    }
    if (q.includes("set status = 'failed'")) {
      const charge = this.tables.company_recurring_charges.find((row) => row.id === binds[2]);
      if (charge) {
        charge.status = "failed";
        charge.failure_reason = binds[0];
        charge.updated_at = binds[1];
      }
    }
    if (q.includes("set status = 'canceled'")) {
      const charge = this.tables.company_recurring_charges.find((row) => row.id === binds[3]);
      if (charge) {
        charge.status = "canceled";
        charge.canceled_by = binds[0];
        charge.canceled_at = binds[1];
        charge.updated_at = binds[2];
      }
    }
    if (q.includes("where stripe_subscription_id = ?")) {
      const charge = this.tables.company_recurring_charges.find(
        (row) => row.stripe_subscription_id === binds[7],
      );
      if (charge) {
        charge.status = binds[0] ?? charge.status;
        charge.canceled_by = binds[1] ?? charge.canceled_by;
        charge.canceled_at = binds[2] ?? charge.canceled_at;
        charge.last_invoice_id = binds[3] ?? charge.last_invoice_id;
        charge.last_invoice_status = binds[4] ?? charge.last_invoice_status;
        charge.last_invoice_at = binds[5] ?? charge.last_invoice_at;
        charge.updated_at = binds[6];
      }
    }
  }
}

function env(db = new FakeD1()): Env {
  return {
    DB: db as unknown as D1Database,
    ENVIRONMENT: "test",
    SESSION_SECRET: "test-session-secret",
    ALLOWED_ORIGINS: "http://localhost:5173",
    STRIPE_SECRET_KEY: "sk_test_recurring",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
  };
}

function mockStripe() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push({ url: String(url), init });
    const text = String(url);
    if (text.includes("/v1/customers/cus_el") && (!init?.method || init.method === "GET")) {
      return Response.json({ id: "cus_el" });
    }
    if (text.endsWith("/v1/products")) {
      return Response.json({ id: "prod_recurring" });
    }
    if (text.endsWith("/v1/prices")) {
      return Response.json({ id: "price_recurring" });
    }
    if (text.endsWith("/v1/subscriptions") && init?.method === "POST") {
      return Response.json({
        id: "sub_recurring",
        status: "active",
        latest_invoice: { id: "in_initial" },
      });
    }
    if (text.includes("/v1/subscriptions/sub_recurring") && init?.method === "DELETE") {
      return Response.json({ id: "sub_recurring", status: "canceled" });
    }
    return Response.json({ data: [] });
  });
  return calls;
}

describe("company recurring billing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists companies with saved Stripe card status for the admin form", async () => {
    const database = new FakeD1();
    const companies = await listRecurringBillingCompanies(database as unknown as D1Database);
    expect(companies).toHaveLength(1);
    expect(companies[0]?.name).toBe("EL Business");
    expect(companies[0]?.paymentMethodReady).toBe(true);
    expect(companies[0]?.paymentMethod.last4).toBe("4242");
  });

  it("creates a Stripe Product, Price, and Subscription for a saved company card", async () => {
    const database = new FakeD1();
    const calls = mockStripe();

    const result = await createCompanyRecurringCharge(env(database), {
      companyId: "co_el",
      amountCents: 5000,
      currency: "GBP",
      interval: "monthly",
      description: "EL Business agent bot monthly subscription",
      createdBy: "admin@infra.test",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amountCents).toBe(5000);
    expect(result.value.stripeSubscriptionId).toBe("sub_recurring");
    expect(result.value.status).toBe("active");

    const subscriptionCall = calls.find((call) => call.url.endsWith("/v1/subscriptions"));
    expect(String(subscriptionCall?.init?.body)).toContain("customer=cus_el");
    expect(String(subscriptionCall?.init?.body)).toContain("default_payment_method=pm_card");
    expect(String(subscriptionCall?.init?.body)).toContain("payment_behavior=error_if_incomplete");
    expect(String(subscriptionCall?.init?.body)).toContain("metadata%5Binfra_recurring_charge_id%5D=");

    const saved = await listCompanyRecurringCharges(database as unknown as D1Database);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.companyName).toBe("EL Business");
  });

  it("returns clear messaging and does not create a subscription when the card is missing", async () => {
    const database = new FakeD1();
    database.tables.payment_provider_accounts[0]!.payment_method_id = null;
    database.tables.payment_provider_accounts[0]!.payment_method_status = "none";
    mockStripe();

    const result = await createCompanyRecurringCharge(env(database), {
      companyId: "co_el",
      amountCents: 5000,
      currency: "GBP",
      interval: "monthly",
      description: "EL Business agent bot monthly subscription",
      createdBy: "admin@infra.test",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NO_PAYMENT_METHOD");
    expect(result.error).toContain("No saved payment method");
    expect(database.tables.company_recurring_charges).toHaveLength(0);
  });

  it("cancels an active recurring charge through Stripe and audits local state", async () => {
    const database = new FakeD1();
    mockStripe();
    const created = await createCompanyRecurringCharge(env(database), {
      companyId: "co_el",
      amountCents: 5000,
      currency: "GBP",
      interval: "monthly",
      description: "EL Business agent bot monthly subscription",
      createdBy: "admin@infra.test",
    });
    if (!created.ok) throw new Error(`${created.code}: ${created.error}`);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const canceled = await cancelCompanyRecurringCharge(env(database), {
      chargeId: created.value.id,
      actorEmail: "admin@infra.test",
    });

    expect(canceled.ok).toBe(true);
    if (!canceled.ok) return;
    expect(canceled.value.status).toBe("canceled");
    expect(canceled.value.canceledBy).toBe("admin@infra.test");
  });

  it("updates recurring charge state from Stripe invoice and subscription webhooks", async () => {
    const database = new FakeD1();
    mockStripe();
    const created = await createCompanyRecurringCharge(env(database), {
      companyId: "co_el",
      amountCents: 5000,
      currency: "GBP",
      interval: "monthly",
      description: "EL Business agent bot monthly subscription",
      createdBy: "admin@infra.test",
    });
    if (!created.ok) throw new Error(`${created.code}: ${created.error}`);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const invoice = await processRecurringCompanyBillingWebhook(env(database), {
      stripeEventId: "evt_invoice",
      eventType: "invoice.paid",
      payload: {
        data: { object: { id: "in_paid", subscription: "sub_recurring" } },
      },
    });
    expect(invoice.processed).toBe(true);

    const deleted = await processRecurringCompanyBillingWebhook(env(database), {
      stripeEventId: "evt_deleted",
      eventType: "customer.subscription.deleted",
      payload: {
        data: { object: { id: "sub_recurring", status: "canceled", canceled_at: 1789250000 } },
      },
    });
    expect(deleted.processed).toBe(true);

    const charges = await listCompanyRecurringCharges(database as unknown as D1Database);
    expect(charges[0]?.lastInvoiceStatus).toBe("paid");
    expect(charges[0]?.status).toBe("canceled");
    expect(charges[0]?.canceledBy).toBe("stripe-webhook");
  });

  it("enforces platform admin middleware for recurring billing mutations", async () => {
    const denied: string[] = [];
    const c = {
      get: () => ({ isPlatformAdmin: false, email: "staff@example.com" }),
      json: (body: unknown, status: number) => {
        denied.push(`${status}:${(body as { error?: string }).error}`);
        return body;
      },
    };
    await requirePlatformAdmin(c as never, async () => {
      throw new Error("next should not run");
    });
    expect(denied).toEqual(["403:Platform administrator access required"]);
  });
});
