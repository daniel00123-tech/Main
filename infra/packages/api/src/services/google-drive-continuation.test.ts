import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyGoogleDriveContinuationPatches } from "../../../caddington-mcp/scripts/google-drive-continuation-patch.mjs";
import { applyGoogleDriveUrlPatches } from "../../../caddington-mcp/scripts/google-drive-url-patch.mjs";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const basePath = path.join(pkgRoot, "caddington-mcp/vendor/base.worker.js");

describe("google drive continuation patches", () => {
  it("adds resumable scan auto-continuation helpers and queue dispatch", () => {
    const base = fs.readFileSync(basePath, "utf8");
    const patched = applyGoogleDriveContinuationPatches(base);
    expect(patched).toContain("google_drive_auto_continuation");
    expect(patched).toContain("enqueueGoogleDriveScanBatch");
    expect(patched).toContain("processGoogleDriveQueueMessage");
    expect(patched).toContain("queued_auto_continuation");
    expect(patched).toContain("scan_continuation_pending");
    expect(patched).toContain('kind: "scan_batch"');
    expect(patched).toContain('kind: "file"');
  });

  it("is idempotent when applied twice", () => {
    const base = fs.readFileSync(basePath, "utf8");
    const once = applyGoogleDriveContinuationPatches(base);
    const twice = applyGoogleDriveContinuationPatches(once);
    expect(twice).toBe(once);
    expect((twice.match(/enqueueGoogleDriveScanBatch/g) ?? []).length).toBeGreaterThan(0);
  });
});

describe("google drive provider URL patches", () => {
  it("requests webViewLink and exposes it on search/fetch/backfill", () => {
    const base = fs.readFileSync(basePath, "utf8");
    const patched = applyGoogleDriveUrlPatches(applyGoogleDriveContinuationPatches(base));
    expect(patched).toContain("webViewLink,webContentLink");
    expect(patched).toContain("webViewLink: file2.webViewLink");
    expect(patched).toContain("firstHttpUrlFromDriveMeta");
    expect(patched).toContain("/admin/knowledge/backfill-provider-urls");
    expect(patched).not.toContain("https://drive.google.com/file/d/");
  });

  it("is idempotent when applied twice", () => {
    const base = fs.readFileSync(basePath, "utf8");
    const once = applyGoogleDriveUrlPatches(applyGoogleDriveContinuationPatches(base));
    const twice = applyGoogleDriveUrlPatches(once);
    expect(twice).toBe(once);
  });
});
