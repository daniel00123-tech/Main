import { describe, expect, it } from "vitest";
import {
  actionForProtectedCapability,
  buildStructuredPermissionDenial,
  capabilityFromAction,
  inferProtectedCapabilityFromQuery,
  userFacingNotConnectedMessage,
  userFacingPermissionDeniedMessage,
  userFacingTechnicalFailureMessage,
} from "./capability-access";

describe("capability access copy", () => {
  it("keeps the four Xero states distinct", () => {
    const denied = userFacingPermissionDeniedMessage({
      capability: "xero",
      connected: true,
      role: "office_staff",
      companyName: "EL Business",
    });
    expect(denied).toContain("Xero is connected for EL Business");
    expect(denied).toContain("Office Staff");
    expect(denied).not.toMatch(/no results|RBAC|403|MCP/i);

    expect(userFacingNotConnectedMessage("xero", "EL Business")).toBe(
      "Xero isn’t connected for EL Business.",
    );
    expect(userFacingTechnicalFailureMessage("xero")).toBe(
      "I couldn’t retrieve Xero data just now.",
    );
    expect(denied).not.toBe(userFacingTechnicalFailureMessage("xero"));
  });

  it("uses generic copy for finance, payments, and admin", () => {
    expect(
      userFacingPermissionDeniedMessage({
        capability: "finance_mailbox",
        connected: true,
        role: "office_staff",
      }),
    ).toContain("Finance email is connected");
    expect(
      userFacingPermissionDeniedMessage({
        capability: "payments",
        connected: true,
        role: "office_staff",
      }),
    ).toBe("Your current permissions don’t allow you to make payments.");
    expect(
      userFacingPermissionDeniedMessage({
        capability: "admin",
        connected: true,
        role: "office_staff",
      }),
    ).toBe("Your current permissions don’t allow access to administration.");
  });

  it("structures permission denial without leaking figures", () => {
    const denial = buildStructuredPermissionDenial({
      capability: "xero",
      connected: true,
      role: "office_staff",
      companyName: "EL Business",
    });
    expect(denial.error).toBe("permission_denied");
    expect(denial.reason).toBe("user_not_authorised");
    expect(denial.userAllowed).toBe(false);
    expect(denial.connected).toBe(true);
    expect(denial.message).not.toMatch(/£|GBP|sales total|invoice/i);
  });
});

describe("capability inference", () => {
  it("maps William's Xero sales question to the xero capability", () => {
    expect(inferProtectedCapabilityFromQuery("tell me on xero what our sales are")).toBe("xero");
    expect(inferProtectedCapabilityFromQuery("Xero current sales total month to date")).toBe("xero");
  });

  it("does not treat a Xero process document question as live finance", () => {
    expect(inferProtectedCapabilityFromQuery("Where is the Xero invoice approval process written down?")).toBeNull();
  });

  it("maps finance mailbox, payments, and admin questions", () => {
    expect(inferProtectedCapabilityFromQuery("Show finance emails")).toBe("finance_mailbox");
    expect(inferProtectedCapabilityFromQuery("Make a payment")).toBe("payments");
    expect(inferProtectedCapabilityFromQuery("Show me admin users")).toBe("admin");
  });

  it("maps tools and mailboxes to capabilities", () => {
    expect(capabilityFromAction({ toolName: "xero_sales_summary", action: "xero.sales.read" })).toBe("xero");
    expect(
      capabilityFromAction({
        toolName: "outlook_list_messages",
        action: "outlook.search",
        mailboxAddress: "finance@elvexpropertyservices.com",
      }),
    ).toBe("finance_mailbox");
    expect(actionForProtectedCapability("xero")).toBe("xero.sales.read");
  });
});
