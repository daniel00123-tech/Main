import { describe, expect, it } from "vitest";
import {
  buildGoogleDriveListQuery,
  classifyGoogleDriveFile,
  DEFAULT_GOOGLE_DRIVE_ALLOWLIST_CONFIG,
  isGoogleDriveFileAllowed,
  parseGoogleDriveAllowListConfig,
  resolveGoogleDriveDownloadMime,
  suggestedStoredFilename,
} from "../src/google-drive-allowlist";
import { GOOGLE_DRIVE_OAUTH_SCOPES } from "../src/google-drive-client";

describe("Google Drive documents-only allow-list", () => {
  const config = DEFAULT_GOOGLE_DRIVE_ALLOWLIST_CONFIG;

  it("allows business document MIME types", () => {
    expect(
      isGoogleDriveFileAllowed(
        { name: "quote.pdf", mimeType: "application/pdf" },
        config
      )
    ).toBe(true);
    expect(
      isGoogleDriveFileAllowed(
        { name: "sheet.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        config
      )
    ).toBe(true);
    expect(
      isGoogleDriveFileAllowed(
        { name: "Notes", mimeType: "application/vnd.google-apps.document" },
        config
      )
    ).toBe(true);
  });

  it("rejects personal photos and media before download", () => {
    const rejected = [
      { name: "holiday.jpg", mimeType: "image/jpeg" },
      { name: "family.png", mimeType: "image/png" },
      { name: "scan.webp", mimeType: "image/webp" },
      { name: "clip.mp4", mimeType: "video/mp4" },
      { name: "voice.m4a", mimeType: "audio/mp4" },
      { name: "photo.heic", mimeType: "image/heic" },
      { name: "Album", mimeType: "application/vnd.google-apps.photo" },
    ];

    for (const file of rejected) {
      const decision = classifyGoogleDriveFile(file, config);
      expect(decision.allowed).toBe(false);
    }
  });

  it("rejects media by file extension even when MIME is octet-stream", () => {
    expect(
      classifyGoogleDriveFile(
        { name: "IMG_1234.JPG", mimeType: "application/octet-stream" },
        config
      ).allowed
    ).toBe(false);
  });

  it("allows document extensions with octet-stream MIME", () => {
    expect(
      classifyGoogleDriveFile(
        { name: "policy.pdf", mimeType: "application/octet-stream" },
        config
      ).allowed
    ).toBe(true);
  });

  it("only permits extra MIME types via additionalAllowedMimeTypes", () => {
    const baseConfig = parseGoogleDriveAllowListConfig({});
    expect(
      isGoogleDriveFileAllowed(
        { name: "archive.zip", mimeType: "application/zip" },
        baseConfig
      )
    ).toBe(false);

    const extended = parseGoogleDriveAllowListConfig({
      additionalAllowedMimeTypes: ["application/zip"],
    });
    expect(
      classifyGoogleDriveFile(
        { name: "archive.zip", mimeType: "application/zip" },
        extended
      ).reason
    ).toBe("additional_allowlist");
  });

  it("maps Google Workspace files to Office export formats", () => {
    expect(
      resolveGoogleDriveDownloadMime("application/vnd.google-apps.document")
    ).toEqual({
      downloadMimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      exportRequired: true,
    });
    expect(
      suggestedStoredFilename(
        "Project Plan",
        "application/vnd.google-apps.document",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
    ).toBe("Project Plan.docx");
  });

  it("uses Drive metadata list query without Google Photos scope", () => {
    expect(buildGoogleDriveListQuery()).toContain("trashed = false");
    expect(GOOGLE_DRIVE_OAUTH_SCOPES).toEqual([
      "https://www.googleapis.com/auth/drive.readonly",
    ]);
    expect(GOOGLE_DRIVE_OAUTH_SCOPES.join(" ")).not.toContain("photoslibrary");
  });
});
