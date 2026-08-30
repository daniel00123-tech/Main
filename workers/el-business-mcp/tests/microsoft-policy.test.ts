import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_APPROVED_MAILBOXES,
  loadMicrosoftConfig,
  publicMicrosoftPolicy,
} from "../src/microsoft/config";
import { AccessPolicy, scoreProtectedCandidate } from "../src/microsoft/policy";
import { ElMicrosoftError, sanitizeErrorMessage } from "../src/microsoft/errors";
import { clearMicrosoftTokenCache, microsoftTokenCacheSize } from "../src/microsoft/auth";
import type { Env } from "../src/env";
import type { DirectoryUser } from "../src/microsoft/directory";

function env(overrides: Partial<Env> = {}): Env {
  return {
    EL_BUSINESS_DATA: {} as D1Database,
    EL_MS_TENANT_ID: "tenant",
    EL_MS_CLIENT_ID: "client",
    EL_MS_CLIENT_SECRET: "secret",
    ...overrides,
  };
}

function config() {
  return loadMicrosoftConfig(env())!;
}

describe("EL Microsoft configuration", () => {
  it("defaults to finance and info shared mailboxes", () => {
    const loaded = loadMicrosoftConfig(env());
    expect(loaded?.approvedMailboxes).toEqual([...DEFAULT_APPROVED_MAILBOXES]);
    expect(publicMicrosoftPolicy(loaded).clientSecretConfigured).toBe(true);
  });

  it("is configuration-driven via comma-separated env vars", () => {
    const loaded = loadMicrosoftConfig(
      env({
        EL_MS_APPROVED_MAILBOXES: "finance@elvexpropertyservices.com,ops@elvexpropertyservices.com",
        EL_MS_PROTECTED_USERS: "William,Ella,HR Director",
      })
    );
    expect(loaded?.approvedMailboxes).toContain("ops@elvexpropertyservices.com");
    expect(loaded?.protectedUserHints).toEqual(["William", "Ella", "HR Director"]);
  });

  it("returns null when credentials are missing", () => {
    expect(loadMicrosoftConfig(env({ EL_MS_CLIENT_SECRET: undefined }))).toBeNull();
  });
});

describe("mailbox allowlist", () => {
  it("allows only approved shared mailboxes", () => {
    const policy = new AccessPolicy(config());
    expect(policy.assertApprovedMailbox("Finance@elvexpropertyservices.com")).toBe(
      "finance@elvexpropertyservices.com"
    );
    expect(() => policy.assertApprovedMailbox("daniel@elvexpropertyservices.com")).toThrow(
      ElMicrosoftError
    );
    try {
      policy.assertApprovedMailbox("william@elvexpropertyservices.com");
    } catch (error) {
      expect(error).toBeInstanceOf(ElMicrosoftError);
      expect((error as ElMicrosoftError).code).toBe("EL_MS_MAILBOX_DENIED");
    }
  });

  it("restricts calendars to the same conservative allowlist", () => {
    const policy = new AccessPolicy(config());
    expect(policy.assertCalendarMailbox("info@elvexpropertyservices.com")).toBe(
      "info@elvexpropertyservices.com"
    );
    expect(() => policy.assertCalendarMailbox("ella@elvexpropertyservices.com")).toThrow(
      /not an approved EL shared mailbox/
    );
  });
});

describe("protected-user deny list", () => {
  it("deny takes precedence over allow for users and drives", () => {
    const policy = new AccessPolicy(config());
    policy.registerProtected({
      id: "william-id",
      displayName: "William Smith",
      mail: "william@elvexpropertyservices.com",
      userPrincipalName: "william@elvexpropertyservices.com",
      givenName: "William",
      matchedHint: "William",
      driveId: "drive-william",
    });

    expect(
      policy.isProtectedUser({
        id: "william-id",
        mail: "william@elvexpropertyservices.com",
      })
    ).toBe(true);
    expect(policy.isProtectedDrive("drive-william")).toBe(true);
    expect(() =>
      policy.assertDriveAllowed("drive-william", { id: "someone-else" })
    ).toThrow(/protected user/);
    expect(policy.isProtectedUser({ displayName: "William Jones" })).toBe(true);
    expect(policy.isProtectedUser({ displayName: "Alex Taylor", mail: "alex@elvexpropertyservices.com" })).toBe(
      false
    );
  });

  it("prefers Elvex-domain William/Ella accounts when scoring", () => {
    const williamWork: DirectoryUser = {
      id: "1",
      displayName: "William Example",
      givenName: "William",
      surname: "Example",
      mail: "william@elvexpropertyservices.com",
      userPrincipalName: "william@elvexpropertyservices.com",
      jobTitle: "Director",
      accountEnabled: true,
    };
    const williamOther: DirectoryUser = {
      id: "2",
      displayName: "William Contractor",
      givenName: "William",
      surname: "Contractor",
      mail: "william@gmail.com",
      userPrincipalName: "william@gmail.com",
      jobTitle: null,
      accountEnabled: true,
    };
    expect(scoreProtectedCandidate(williamWork, "William")).toBeGreaterThan(
      scoreProtectedCandidate(williamOther, "William")
    );
  });
});

describe("error sanitisation", () => {
  it("never echoes tokens or client secrets", () => {
    expect(sanitizeErrorMessage("Bearer abc.def.ghi client_secret=super-secret")).toContain(
      "[redacted]"
    );
    expect(sanitizeErrorMessage('{"access_token":"xyz"}')).not.toContain("xyz");
  });
});

describe("token cache helpers", () => {
  beforeEach(() => {
    clearMicrosoftTokenCache();
  });

  it("starts empty and can be cleared", () => {
    expect(microsoftTokenCacheSize()).toBe(0);
    clearMicrosoftTokenCache();
    expect(microsoftTokenCacheSize()).toBe(0);
  });
});
