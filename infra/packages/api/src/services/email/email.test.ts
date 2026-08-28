import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  isTransactionalEmailType,
  renderPasswordResetEmail,
} from "@infra/shared";
import { resolveApprovedSender, EmailSenderError } from "./sender-resolver";
import { senderMatchesAllowlist, normaliseSenderAddress } from "./company-config";
import { sendTransactionalEmail } from "./send-transactional";
import { exchangeMailSendRbacGuide } from "./providers/microsoft-graph";

describe("transactional email security", () => {
  it("rejects unknown email types", () => {
    expect(isTransactionalEmailType("MARKETING_BLAST")).toBe(false);
    expect(isTransactionalEmailType("PASSWORD_RESET")).toBe(true);
  });

  it("enforces approved sender allowlist", () => {
    const config = {
      senderAddress: "admin@CaddingtonHoldings.co.uk",
      allowedTypes: [],
      companyId: "co_caddington",
    } as import("@infra/shared").CompanyEmailConfig;
    expect(senderMatchesAllowlist(config, "admin@CaddingtonHoldings.co.uk")).toBe(true);
    expect(senderMatchesAllowlist(config, "attacker@evil.com")).toBe(false);
  });

  it("normalises sender addresses case-insensitively", () => {
    expect(normaliseSenderAddress("Admin@Example.COM")).toBe("admin@example.com");
  });
});

describe("resolveApprovedSender", () => {
  const db = {
    prepare: vi.fn(),
  } as unknown as D1Database;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects arbitrary sender override attempts", async () => {
    vi.mocked(db.prepare).mockReturnValue({
      bind: () => ({
        first: async () => ({
          id: "cec_1",
          company_id: "co_caddington",
          provider: "microsoft365",
          sender_address: "admin@CaddingtonHoldings.co.uk",
          sender_display_name: "Caddington Holdings",
          enabled: 1,
          allowed_types_json: '["PASSWORD_RESET"]',
          health_status: "permission_required",
          last_sent_at: null,
          last_error_category: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        }),
      }),
    } as never);

    await expect(
      resolveApprovedSender(db, {
        companyId: "co_caddington",
        emailType: "PASSWORD_RESET",
        requestedFrom: "other@example.com",
      }),
    ).rejects.toMatchObject({ code: "SENDER_NOT_ALLOWED" });
  });

  it("rejects when company has no configuration", async () => {
    vi.mocked(db.prepare).mockReturnValue({
      bind: () => ({ first: async () => null }),
    } as never);

    await expect(
      resolveApprovedSender(db, {
        companyId: "co_ht",
        emailType: "PASSWORD_RESET",
      }),
    ).rejects.toMatchObject({ code: "EMAIL_NOT_CONFIGURED" });
  });
});

describe("password reset template", () => {
  it("does not embed token in subject", () => {
    const rendered = renderPasswordResetEmail({
      companyDisplayName: "Caddington Holdings",
      resetUrl: "https://example.com/setup-password?token=secret-token-value",
      expiresLabel: "in 1 hour",
    });
    expect(rendered.subject).not.toContain("secret-token-value");
  });
});

describe("microsoft outbound permission guide", () => {
  it("documents Mail.Send without Mail.Read", () => {
    const guide = exchangeMailSendRbacGuide({
      approvedMailbox: "admin@CaddingtonHoldings.co.uk",
    });
    expect(guide.permission).toBe("Mail.Send");
    expect(
      guide.entraSteps.some((step) => /^Add Mail\.Read/i.test(step.trim())),
    ).toBe(false);
    expect(guide.securityEffect).toContain("Does not broaden Mail.Read");
  });
});

describe("sendTransactionalEmail audit safety", () => {
  it("records delivery without token-like secrets in audit detail", async () => {
    const runCalls: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          binds: [] as unknown[],
          bind(...values: unknown[]) {
            this.binds = values;
            return this;
          },
          async run() {
            runCalls.push({ sql, binds: this.binds });
            return { success: true };
          },
          async first() {
            if (sql.includes("company_email_config")) {
              return {
                id: "cec_1",
                company_id: "co_caddington",
                provider: "resend",
                sender_address: "admin@CaddingtonHoldings.co.uk",
                sender_display_name: "Caddington Holdings",
                enabled: 1,
                allowed_types_json: '["PASSWORD_RESET"]',
                health_status: "healthy",
                last_sent_at: null,
                last_error_category: null,
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
              };
            }
            return null;
          },
        };
      },
    } as unknown as D1Database;

    const env = {
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "INFRA <noreply@test.local>",
    } as never;

    global.fetch = vi.fn(async () =>
      Response.json({ id: "msg_123" }, { status: 200 }),
    ) as never;

    const result = await sendTransactionalEmail(env, db, {
      companyId: "co_caddington",
      type: "PASSWORD_RESET",
      recipient: "user@example.com",
      subject: "Reset",
      bodyText: "text",
      bodyHtml: "<p>text</p>",
      actor: "user@example.com",
    });

    expect(result.sent).toBe(true);
    const insert = runCalls.find((call) => call.sql.includes("INSERT INTO email_outbox"));
    expect(JSON.stringify(insert?.binds ?? [])).not.toContain("token=");
  });
});

describe("EmailSenderError", () => {
  it("exposes stable error codes", () => {
    const err = new EmailSenderError("SENDER_NOT_ALLOWED", "nope");
    expect(err.code).toBe("SENDER_NOT_ALLOWED");
  });
});
