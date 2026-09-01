import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  PLATFORM_EMAIL_FROM_ADDRESS,
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
    expect(isTransactionalEmailType("XERO_SALES_REPORT")).toBe(true);
    expect(isTransactionalEmailType("DOCUMENT_ACTIVITY_REPORT")).toBe(true);
  });

  it("keeps company-config allowlist matching for stored rows", () => {
    const config = {
      senderAddress: PLATFORM_EMAIL_FROM_ADDRESS,
      allowedTypes: [],
      companyId: "co_caddington",
    } as import("@infra/shared").CompanyEmailConfig;
    expect(senderMatchesAllowlist(config, PLATFORM_EMAIL_FROM_ADDRESS)).toBe(true);
    expect(senderMatchesAllowlist(config, "attacker@evil.com")).toBe(false);
  });

  it("normalises sender addresses case-insensitively", () => {
    expect(normaliseSenderAddress("Admin@Example.COM")).toBe("admin@example.com");
  });
});

describe("resolveApprovedSender", () => {
  it("rejects arbitrary sender override attempts", () => {
    try {
      resolveApprovedSender(undefined, {
        companyId: "co_caddington",
        emailType: "PASSWORD_RESET",
        requestedFrom: "other@example.com",
      });
      expect.fail("expected sender override to be rejected");
    } catch (err) {
      expect(err).toMatchObject({ code: "SENDER_NOT_ALLOWED" });
    }
  });

  it("uses the Infra platform sender for every tenant", () => {
    const sender = resolveApprovedSender(undefined, {
      companyId: "co_ht",
      emailType: "PASSWORD_RESET",
    });
    expect(sender.fromEmail).toBe(PLATFORM_EMAIL_FROM_ADDRESS);
    expect(sender.fromDisplayName).toBe("Infra");
    expect(sender.provider).toBe("cloudflare");
  });
});

describe("password reset template", () => {
  it("does not embed token in subject", () => {
    const rendered = renderPasswordResetEmail({
      companyDisplayName: "Caddington Holdings",
      resetUrl: "https://app.infrastack.app/setup-password?token=secret-token-value",
      expiresLabel: "in 1 hour",
    });
    expect(rendered.subject).not.toContain("secret-token-value");
    expect(rendered.text).toContain("Replies to this address are not monitored");
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
  beforeEach(() => {
    vi.restoreAllMocks();
  });

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
            return null;
          },
        };
      },
    } as unknown as D1Database;

    const env = {
      EMAIL: {
        send: vi.fn(async () => ({ messageId: "cf_msg_123" })),
      },
    } as never;

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
    expect(result.provider).toBe("cloudflare");
    const insert = runCalls.find((call) => call.sql.includes("INSERT INTO email_outbox"));
    expect(JSON.stringify(insert?.binds ?? [])).toContain(PLATFORM_EMAIL_FROM_ADDRESS);
    expect(JSON.stringify(insert?.binds ?? [])).not.toContain("token=");
    expect(JSON.stringify(insert?.binds ?? [])).not.toContain("CaddingtonHoldings");
  });
});

describe("EmailSenderError", () => {
  it("exposes stable error codes", () => {
    const err = new EmailSenderError("SENDER_NOT_ALLOWED", "nope");
    expect(err.code).toBe("SENDER_NOT_ALLOWED");
  });
});
