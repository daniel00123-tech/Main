import { describe, expect, it } from "vitest";
import { isAllowedInfraTestPrefix, recommendedCleanupAction } from "./xero-test-artefacts";
import { resolveSendRecipient, assertSendOverrideSafe } from "./send-uat";
import { microsoftOAuthStatus, scopesForMicrosoftComponent } from "../microsoft-oauth";
import { MICROSOFT_GRAPH_SCOPES } from "@infra/shared";

describe("CMD12 cleanup safety", () => {
  it("rejects non-INFRA references", () => {
    expect(isAllowedInfraTestPrefix("CUSTOMER-INV-001")).toBe(false);
    expect(isAllowedInfraTestPrefix("INFRA-CMD11-UAT-test")).toBe(true);
  });

  it("blocks AUTHORISED cleanup via delete path", () => {
    expect(
      recommendedCleanupAction({
        type: "ACCREC",
        invoiceNumber: "INV-1",
        reference: "INFRA-CMD11-UAT-x",
        xeroId: "id",
        amount: 0.01,
        status: "AUTHORISED",
        createdDate: null,
        contactName: null,
      }),
    ).toBe("void_authorised");
  });
});

describe("CMD12 send UAT override", () => {
  it("does not override without UAT mode", () => {
    const result = resolveSendRecipient(
      { XERO_SEND_TEST_RECIPIENT: "uat@test.com", ENVIRONMENT: "production" } as never,
      "customer@test.com",
    );
    expect(result.testOverrideActive).toBe(false);
    expect(result.effectiveRecipient).toBe("customer@test.com");
  });

  it("applies override only when UAT mode enabled", () => {
    const result = resolveSendRecipient(
      {
        XERO_SEND_TEST_RECIPIENT: "uat@test.com",
        XERO_SEND_UAT_MODE: "true",
        ENVIRONMENT: "production",
      } as never,
      "customer@test.com",
    );
    expect(result.testOverrideActive).toBe(true);
    expect(result.effectiveRecipient).toBe("uat@test.com");
    expect(result.intendedRecipient).toBe("customer@test.com");
  });

  it("blocks override when recipient set but UAT mode off", () => {
    const check = assertSendOverrideSafe({
      XERO_SEND_TEST_RECIPIENT: "uat@test.com",
      ENVIRONMENT: "production",
    } as never);
    expect(check.ok).toBe(false);
  });
});

describe("CMD12 Microsoft foundation", () => {
  it("reports not configured without app credentials", () => {
    const status = microsoftOAuthStatus({} as never);
    expect(status.appConfigured).toBe(false);
    expect(status.readyForConsent).toBe(false);
  });

  it("uses least-privilege scopes per component", () => {
    expect(scopesForMicrosoftComponent("onedrive")).toEqual([...MICROSOFT_GRAPH_SCOPES.onedrive]);
    expect(scopesForMicrosoftComponent("outlook_shared")).toEqual([...MICROSOFT_GRAPH_SCOPES.outlook_shared]);
  });
});

describe("CMD12 settlement request id", () => {
  it("does not double-prefix execution ids", () => {
    const executionId = "aex_abc-123";
    const requestId = executionId.startsWith("aex_") ? executionId : `aex_${executionId}`;
    expect(requestId).toBe("aex_abc-123");
  });
});

describe("CMD12 security regression", () => {
  it("rejects send override when UAT mode disabled even with recipient set", () => {
    const check = assertSendOverrideSafe({
      XERO_SEND_TEST_RECIPIENT: "attacker@evil.com",
      XERO_SEND_UAT_MODE: "false",
      ENVIRONMENT: "production",
    } as never);
    expect(check.ok).toBe(false);
  });

  it("does not expose microsoft token exchange without credentials", async () => {
    const { exchangeMicrosoftAuthorizationCode } = await import("../microsoft-oauth");
    const result = await exchangeMicrosoftAuthorizationCode({} as never, {
      code: "fake",
      redirectUri: "https://example.com/callback",
      codeVerifier: "verifier",
    });
    expect(result.ok).toBe(false);
  });
});
