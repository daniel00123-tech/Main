import { describe, expect, it } from "vitest";
import { AccessPolicy } from "../src/microsoft/policy";
import { loadMicrosoftConfig } from "../src/microsoft/config";
import { assertIndexableFile } from "../src/microsoft/knowledge";
import type { FileHit } from "../src/microsoft/files";
import type { Env } from "../src/env";

function policy(): AccessPolicy {
  const access = new AccessPolicy(
    loadMicrosoftConfig({
      EL_BUSINESS_DATA: {} as D1Database,
      EL_MS_TENANT_ID: "t",
      EL_MS_CLIENT_ID: "c",
      EL_MS_CLIENT_SECRET: "s",
    } satisfies Env)!
  );
  access.registerProtected({
    id: "ella-id",
    displayName: "Ella Example",
    mail: "ella@elvexpropertyservices.com",
    userPrincipalName: "ella@elvexpropertyservices.com",
    givenName: "Ella",
    matchedHint: "Ella",
    driveId: "drive-ella",
  });
  return access;
}

function hit(overrides: Partial<FileHit> = {}): FileHit {
  return {
    id: "item-1",
    name: "notes.docx",
    webUrl: "https://elvexpropertyservicesltd.sharepoint.com/notes.docx",
    size: 12,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    lastModifiedDateTime: "2026-08-30T10:00:00Z",
    folder: false,
    sourceType: "onedrive",
    driveId: "drive-open",
    siteId: null,
    owner: { id: "alex-id", displayName: "Alex", mail: "alex@elvexpropertyservices.com" },
    path: "/drive/root:",
    provenance: "Microsoft 365 → OneDrive → Alex → notes.docx",
    ...overrides,
  };
}

describe("knowledge index exclusion", () => {
  it("never marks protected-owner files as indexable", () => {
    const access = policy();
    expect(assertIndexableFile(access, hit())).toBe(true);
    expect(
      assertIndexableFile(
        access,
        hit({
          driveId: "drive-ella",
          owner: { id: "ella-id", displayName: "Ella Example", mail: "ella@elvexpropertyservices.com" },
        })
      )
    ).toBe(false);
  });
});
