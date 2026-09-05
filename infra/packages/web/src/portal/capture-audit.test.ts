import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("INFRA portal capture audit", () => {
  it("does not apply FLAG_SECURE, secure-screen, or capture-prevention headers in INFRA-owned web", () => {
    const index = readFileSync(resolve(webRoot, "index.html"), "utf8");
    const css = readFileSync(resolve(webRoot, "src/styles.css"), "utf8");
    const hay = `${index}\n${css}`;
    expect(hay).not.toMatch(/FLAG_SECURE|secure-screen|preventScreenshots|captureProtection|window\.secure/i);
    expect(index).not.toMatch(/Permissions-Policy[^>]*display-capture/);
  });
});
