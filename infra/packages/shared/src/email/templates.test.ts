import { describe, expect, it } from "vitest";
import { PLATFORM_EMAIL_NO_REPLY_FOOTER } from "./identity";
import { renderPasswordResetEmail, renderUserInvitationEmail } from "./templates";

describe("email templates", () => {
  it("renders branded password reset copy without internal architecture terms", () => {
    const rendered = renderPasswordResetEmail({
      companyDisplayName: "Caddington Holdings",
      resetUrl: "https://app.infrastack.app/setup-password?token=abc",
      expiresLabel: "in 1 hour",
    });
    expect(rendered.subject).toContain("Caddington Holdings");
    expect(rendered.text).toContain("Reset your Infra password");
    expect(rendered.text).toContain(PLATFORM_EMAIL_NO_REPLY_FOOTER);
    expect(rendered.text).not.toContain("Graph");
    expect(rendered.text).not.toContain("pages.dev");
    expect(rendered.html).toContain("Reset password");
    expect(rendered.html).toContain("https://app.infrastack.app/setup-password?token=abc");
  });

  it("renders invitation template with company context and Infra sender copy", () => {
    const rendered = renderUserInvitationEmail({
      companyDisplayName: "Elvex Property Services",
      setupUrl: "https://app.infrastack.app/setup-password?token=abc",
      expiresLabel: "7 days",
    });
    expect(rendered.subject).toContain("Elvex Property Services");
    expect(rendered.text).toContain("You have been invited to access Elvex Property Services in Infra.");
    expect(rendered.text).toContain("Set up your account");
    expect(rendered.text).toContain(PLATFORM_EMAIL_NO_REPLY_FOOTER);
    expect(rendered.text).not.toMatch(/reply to this email/i);
  });
});
