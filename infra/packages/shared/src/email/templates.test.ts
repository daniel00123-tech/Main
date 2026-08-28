import { describe, expect, it } from "vitest";
import { renderPasswordResetEmail, renderUserInvitationEmail } from "./templates";

describe("email templates", () => {
  it("renders branded password reset copy without internal architecture terms", () => {
    const rendered = renderPasswordResetEmail({
      companyDisplayName: "Caddington Holdings",
      resetUrl: "https://caddington.infra-web.pages.dev/setup-password?token=abc",
      expiresLabel: "in 1 hour",
    });
    expect(rendered.subject).toContain("Caddington Holdings");
    expect(rendered.text).toContain("Reset your password");
    expect(rendered.text).not.toContain("Graph");
    expect(rendered.html).toContain("Reset password");
  });

  it("renders invitation template with company context", () => {
    const rendered = renderUserInvitationEmail({
      companyDisplayName: "Caddington Holdings",
      setupUrl: "https://example.com/setup-password?token=abc",
      expiresLabel: "7 days",
    });
    expect(rendered.subject).toContain("Caddington Holdings");
    expect(rendered.text).toContain("Set up your account");
  });
});
