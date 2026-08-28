import { describe, expect, it } from "vitest";
import {
  parseGoogleDriveImagePolicy,
  parseGoogleDriveScopeMode,
  resolveGoogleDriveScanRootId,
} from "./google-drive-scope";

describe("google drive scope", () => {
  it("defaults to SELECTED_FOLDERS and EXCLUDED images", () => {
    expect(parseGoogleDriveScopeMode(undefined)).toBe("SELECTED_FOLDERS");
    expect(parseGoogleDriveImagePolicy(undefined)).toBe("EXCLUDED");
  });

  it("resolves ENTIRE_DRIVE to My Drive root", () => {
    expect(
      resolveGoogleDriveScanRootId({
        scopeMode: "ENTIRE_DRIVE",
        imageIngestionPolicy: "EXCLUDED",
      }),
    ).toBe("root");
  });

  it("resolves SELECTED_FOLDERS to configured folder id", () => {
    expect(
      resolveGoogleDriveScanRootId({
        scopeMode: "SELECTED_FOLDERS",
        imageIngestionPolicy: "EXCLUDED",
        knowledgeFolderId: "folder-abc",
      }),
    ).toBe("folder-abc");
  });

  it("returns null when selected folder is missing", () => {
    expect(
      resolveGoogleDriveScanRootId({
        scopeMode: "SELECTED_FOLDERS",
        imageIngestionPolicy: "EXCLUDED",
      }),
    ).toBeNull();
  });
});
