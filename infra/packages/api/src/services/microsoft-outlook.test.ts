import { describe, expect, it, vi } from "vitest";
import {
  OUTLOOK_READ_TOOL_NAMES,
  OUTLOOK_REQUIRED_APP_PERMISSION,
} from "@infra/shared";
import { classifyOutlookMailbox } from "./microsoft-outlook-mailbox";
import {
  isOutlookAttachmentRetrievable,
  formatOutlookProvenance,
} from "./microsoft-outlook-graph";
import {
  isOutlookReadTool,
  outlookReadToolAllowed,
  withOutlookReadTools,
} from "./microsoft-outlook-tools";
import { assessOutlookPermissions } from "./microsoft-outlook-permissions";

describe("Outlook mailbox classification", () => {
  it("classifies unlicensed mail-enabled users as shared mailbox candidates", () => {
    const result = classifyOutlookMailbox({
      id: "u1",
      displayName: "Accounts",
      mail: "accounts@example.com",
      userPrincipalName: "accounts@example.com",
      userType: "Member",
      accountEnabled: true,
      assignedLicenses: [],
    });
    expect(result.mailboxType).toBe("shared_mailbox");
    expect(result.isPersonalLikely).toBe(false);
  });

  it("classifies licensed users as personal mailboxes", () => {
    const result = classifyOutlookMailbox({
      id: "u2",
      displayName: "Daniel Dwyer",
      mail: "daniel@example.com",
      userPrincipalName: "daniel@example.com",
      userType: "Member",
      accountEnabled: true,
      assignedLicenses: [{ skuId: "sku" }],
    });
    expect(result.mailboxType).toBe("personal_mailbox");
    expect(result.isPersonalLikely).toBe(true);
  });
});

describe("Outlook allowlist tools", () => {
  it("advertises tools only with outlook.mail.read scope", () => {
    const base = [{ name: "search_company_knowledge", description: "x", inputSchema: {} }];
    expect(withOutlookReadTools(base, ["knowledge.search"]).length).toBe(1);
    expect(withOutlookReadTools(base, ["outlook.mail.read"]).length).toBe(8);
  });

  it("recognises outlook tool names", () => {
    expect(isOutlookReadTool("outlook_search_mailbox")).toBe(true);
    expect(isOutlookReadTool("search_company_knowledge")).toBe(false);
    expect(outlookReadToolAllowed("outlook_get_message", ["outlook.mail.read"])).toBe(true);
    expect(outlookReadToolAllowed("outlook_get_message", ["knowledge.search"])).toBe(false);
  });

  it("defines seven read tools", () => {
    expect(OUTLOOK_READ_TOOL_NAMES.length).toBe(7);
  });
});

describe("Outlook tenant isolation and allowlist", () => {
  it("denies cross-company mailbox resolution", async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              id: "mss_other",
              mailbox_address: "shared@example.com",
              display_name: "Shared",
              connector_instance_id: "ci_1",
              mailbox_type: "shared_mailbox",
              inclusion_status: "included",
              company_id: "co_other",
            }),
          }),
        }),
      },
    };
    const { resolveIncludedOutlookMailbox } = await import("./microsoft-outlook-mailbox");
    const result = await resolveIncludedOutlookMailbox(env as never, {
      companyId: "co_caddington",
      sourceId: "mss_other",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("OUTLOOK_TENANT_ISOLATION");
  });

  it("denies excluded mailbox", async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              id: "mss_1",
              mailbox_address: "shared@example.com",
              display_name: "Shared",
              connector_instance_id: "ci_1",
              mailbox_type: "shared_mailbox",
              inclusion_status: "available",
              company_id: "co_caddington",
            }),
          }),
        }),
      },
    };
    const { resolveIncludedOutlookMailbox } = await import("./microsoft-outlook-mailbox");
    const result = await resolveIncludedOutlookMailbox(env as never, {
      companyId: "co_caddington",
      mailboxAddress: "shared@example.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("OUTLOOK_MAILBOX_NOT_INCLUDED");
  });

  it("denies personal mailbox by default", async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              id: "mss_p",
              mailbox_address: "user@example.com",
              display_name: "User",
              connector_instance_id: "ci_1",
              mailbox_type: "personal_mailbox",
              inclusion_status: "included",
              company_id: "co_caddington",
            }),
          }),
        }),
      },
    };
    const { resolveIncludedOutlookMailbox } = await import("./microsoft-outlook-mailbox");
    const result = await resolveIncludedOutlookMailbox(env as never, {
      companyId: "co_caddington",
      mailboxAddress: "user@example.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("OUTLOOK_PERSONAL_MAILBOX_DENIED");
  });
});

describe("Outlook attachment support", () => {
  it("allows pdf/docx/xlsx attachments", () => {
    expect(isOutlookAttachmentRetrievable("application/pdf", "invoice.pdf")).toBe(true);
    expect(isOutlookAttachmentRetrievable(null, "model.xlsx")).toBe(true);
    expect(isOutlookAttachmentRetrievable("application/zip", "archive.zip")).toBe(false);
  });
});

describe("Outlook provenance formatting", () => {
  it("formats human-readable provenance chain", () => {
    expect(
      formatOutlookProvenance({
        mailboxAddress: "accounts@caddington.com",
        folderName: "Inbox",
        subject: "Invoice 123",
      }),
    ).toBe("Microsoft 365 → Outlook → accounts@caddington.com → Inbox → Invoice 123");
  });
});

describe("Outlook permission assessment", () => {
  it("reports Mail.Read application permission requirement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("oauth2/v2.0/token")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 3600 }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: { code: "Authorization_RequestDenied" } }), {
          status: 403,
        });
      }),
    );

    const env = {
      MICROSOFT_TENANT_ID: "tenant",
      MICROSOFT_CLIENT_ID: "client",
      MICROSOFT_CLIENT_SECRET: "secret",
      DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
    };

    const { clearMicrosoftTokenCache } = await import("./microsoft-auth");
    clearMicrosoftTokenCache();

    const assessment = await assessOutlookPermissions(env as never, {
      probeMailboxAddress: "accounts@example.com",
    });

    expect(assessment.mailRead.permission).toBe(OUTLOOK_REQUIRED_APP_PERMISSION);
    expect(assessment.mailRead.permissionType).toBe("Application");
    expect(assessment.adminConsentRequired).toBe(true);
    expect(assessment.entraSteps.length).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });
});
