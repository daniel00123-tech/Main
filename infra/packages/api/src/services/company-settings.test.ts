import { describe, expect, it } from "vitest";
import {
  applyCompanySettingsConfigPatch,
  updateCompanySettings,
} from "./company-settings";

describe("applyCompanySettingsConfigPatch", () => {
  it("persists company-scoped Getting Started dismissal once", () => {
    const first = applyCompanySettingsConfigPatch(
      { notifications: { usageAlerts: true } },
      { gettingStartedDismissed: true },
      "2026-08-28T10:00:00.000Z",
    );
    expect(first.gettingStartedDismissedAt).toBe("2026-08-28T10:00:00.000Z");
    expect(first.notifications).toEqual({ usageAlerts: true });

    const again = applyCompanySettingsConfigPatch(
      first,
      { gettingStartedDismissed: true },
      "2026-08-29T10:00:00.000Z",
    );
    expect(again.gettingStartedDismissedAt).toBe("2026-08-28T10:00:00.000Z");
  });

  it("ignores undismiss so the checklist cannot be resurrected via settings", () => {
    const dismissed = applyCompanySettingsConfigPatch(
      { gettingStartedDismissedAt: "2026-08-28T10:00:00.000Z" },
      { gettingStartedDismissed: false },
      "2026-08-29T10:00:00.000Z",
    );
    expect(dismissed.gettingStartedDismissedAt).toBe("2026-08-28T10:00:00.000Z");
  });

  it("does not leak dismissal between separate company config objects", () => {
    const companyA = applyCompanySettingsConfigPatch(
      {},
      { gettingStartedDismissed: true },
      "2026-08-28T10:00:00.000Z",
    );
    const companyB = applyCompanySettingsConfigPatch({}, {}, "2026-08-28T10:00:00.000Z");
    expect(companyA.gettingStartedDismissedAt).toBe("2026-08-28T10:00:00.000Z");
    expect(companyB.gettingStartedDismissedAt).toBeUndefined();
  });
});

type Row = Record<string, unknown>;

class MockStatement {
  constructor(
    private db: SettingsD1,
    private sql: string,
    private binds: unknown[] = [],
  ) {}

  bind(...args: unknown[]) {
    return new MockStatement(this.db, this.sql, args);
  }

  async first() {
    return this.db.query(this.sql, this.binds)[0] ?? null;
  }

  async run() {
    this.db.exec(this.sql, this.binds);
    return { success: true };
  }
}

class SettingsD1 {
  companies: Row[];

  constructor(companies: Row[]) {
    this.companies = companies;
  }

  prepare(sql: string) {
    return new MockStatement(this, sql);
  }

  query(sql: string, binds: unknown[]): Row[] {
    const q = sql.toLowerCase().replace(/\s+/g, " ");
    if (q.includes("select config_json from companies")) {
      return this.companies.filter((row) => row.id === binds[0]);
    }
    if (q.includes("from companies c") && q.includes("where c.id")) {
      return this.companies
        .filter((row) => row.id === binds[0])
        .map((row) => ({
          ...row,
          low_balance_threshold_cents: 500,
          auto_top_up_enabled: 0,
          auto_top_up_threshold_cents: null,
          auto_top_up_amount_cents: null,
          ppa_auto_enabled: null,
          ppa_auto_threshold: null,
          ppa_auto_amount: null,
          payment_method_status: null,
        }));
    }
    return [];
  }

  exec(sql: string, binds: unknown[]) {
    const q = sql.toLowerCase().replace(/\s+/g, " ");
    if (q.includes("update companies set")) {
      const companyId = binds[binds.length - 1];
      const row = this.companies.find((item) => item.id === companyId);
      if (!row) return;
      // last bind before company id is config_json
      row.config_json = binds[binds.length - 2];
      row.updated_at = binds[0];
    }
  }
}

describe("updateCompanySettings getting started dismissal", () => {
  it("writes dismissal onto the target company only", async () => {
    const db = new SettingsD1([
      {
        id: "co_a",
        name: "Alpha",
        config_json: "{}",
        trading_name: null,
        primary_contact_name: null,
        primary_email: null,
        billing_email: null,
        telephone: null,
        timezone: "Europe/London",
        country: null,
      },
      {
        id: "co_b",
        name: "Beta",
        config_json: "{}",
        trading_name: null,
        primary_contact_name: null,
        primary_email: null,
        billing_email: null,
        telephone: null,
        timezone: "Europe/London",
        country: null,
      },
    ]);

    const updated = await updateCompanySettings(db as unknown as D1Database, "co_a", {
      gettingStartedDismissed: true,
    });

    expect(updated.gettingStartedDismissedAt).toBeTruthy();
    const alpha = JSON.parse(String(db.companies[0]!.config_json)) as Record<string, unknown>;
    const beta = JSON.parse(String(db.companies[1]!.config_json)) as Record<string, unknown>;
    expect(alpha.gettingStartedDismissedAt).toBe(updated.gettingStartedDismissedAt);
    expect(beta.gettingStartedDismissedAt).toBeUndefined();
  });
});
