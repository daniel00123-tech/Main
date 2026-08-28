import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyGoogleDriveContinuationPatches } from "./google-drive-continuation-patch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const basePath = path.join(__dirname, "..", "vendor/base.worker.js");

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
  });
});
