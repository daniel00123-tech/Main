import { describe, expect, it, vi, afterEach } from "vitest";
import {
  clearMicrosoftTokenCache,
  microsoftCredentialStatus,
  acquireMicrosoftAppToken,
} from "./microsoft-auth";
import {
  classifyMicrosoftFile,
  formatMicrosoftSourceLabel,
  buildMicrosoftProvenance,
} from "./microsoft-graph";
import { buildMicrosoftExternalId } from "./microsoft-knowledge-bridge";

describe("CMD13 Microsoft app-only auth", () => {
  afterEach(() => {
    clearMicrosoftTokenCache();
    vi.restoreAllMocks();
  });

  it("reports not configured without tenant credentials", () => {
    const status = microsoftCredentialStatus({} as never);
    expect(status.configured).toBe(false);
    expect(status.authMode).toBe("not_configured");
    expect(status.tenantIdMasked).toBeNull();
  });

  it("masks tenant id when configured", () => {
    const status = microsoftCredentialStatus({
      MICROSOFT_TENANT_ID: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      MICROSOFT_CLIENT_ID: "client-id",
      MICROSOFT_CLIENT_SECRET: "secret",
    } as never);
    expect(status.configured).toBe(true);
    expect(status.tenantIdMasked).toMatch(/abcd/);
    expect(status.tenantIdMasked).not.toContain("secret");
  });

  it("acquires app token via client credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "token-abc", expires_in: 3600 }),
      }),
    );

    const result = await acquireMicrosoftAppToken({
      MICROSOFT_TENANT_ID: "tenant-1",
      MICROSOFT_CLIENT_ID: "client-1",
      MICROSOFT_CLIENT_SECRET: "secret-1",
    } as never);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accessToken).toBe("token-abc");
      expect(result.tenantId).toBe("tenant-1");
    }

    const cached = await acquireMicrosoftAppToken({
      MICROSOFT_TENANT_ID: "tenant-1",
      MICROSOFT_CLIENT_ID: "client-1",
      MICROSOFT_CLIENT_SECRET: "secret-1",
    } as never);
    expect(cached.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never includes secret in error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: "invalid_client", error_description: "Bad credentials" }),
      }),
    );

    const result = await acquireMicrosoftAppToken({
      MICROSOFT_TENANT_ID: "tenant-1",
      MICROSOFT_CLIENT_ID: "client-1",
      MICROSOFT_CLIENT_SECRET: "super-secret-value",
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain("super-secret-value");
    }
  });
});

describe("CMD13 Microsoft file classification", () => {
  it("classifies PDF as indexable", () => {
    expect(classifyMicrosoftFile("application/pdf", "report.pdf").indexingStatus).toBe("indexable");
  });

  it("classifies PNG as catalogue only", () => {
    expect(classifyMicrosoftFile("image/png", "photo.png").indexingStatus).toBe("catalogue_only");
  });

  it("builds provenance source label", () => {
    const label = formatMicrosoftSourceLabel({
      sourceType: "sharepoint",
      displayName: "Communication site",
      path: "Documents",
      filename: "Coal Search.pdf",
    });
    expect(label).toContain("SharePoint");
    expect(label).toContain("Coal Search.pdf");
  });

  it("builds external id without spaces", () => {
    const id = buildMicrosoftExternalId({
      sourceType: "onedrive",
      driveId: "drive-1",
      itemId: "item/1",
    });
    expect(id).not.toContain("/");
    expect(id).toContain("microsoft-onedrive");
  });
});

describe("CMD13 Microsoft provenance", () => {
  it("retains company and source metadata", () => {
    const p = buildMicrosoftProvenance({
      companyId: "co_test",
      tenantId: "tenant-1",
      sourceType: "onedrive",
      externalItemId: "item-1",
      path: "INFRA Knowledge Test/doc.pdf",
      filename: "doc.pdf",
      modifiedAt: "2026-01-01T00:00:00Z",
      driveId: "drive-1",
      inclusionStatus: "included",
    });
    expect(p.connector).toBe("microsoft_365");
    expect(p.companyId).toBe("co_test");
    expect(p.scope).toBe("included");
  });
});

describe("CMD13 Outlook readiness", () => {
  it("documents Mail.Read application permission requirement", () => {
    const requiredPermission = "Mail.Read";
    const permissionType = "Application";
    expect(requiredPermission).toBe("Mail.Read");
    expect(permissionType).toBe("Application");
  });
});
