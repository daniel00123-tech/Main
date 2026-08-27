import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  XERO_INJECT_BEGIN,
  XERO_INJECT_END,
  assertNoDuplicateXeroSymbols,
  stripXeroInjection,
} from "./strip-xero-inject.mjs";

const pkgRoot = path.resolve(import.meta.dirname, "..");
const vendorBase = path.join(pkgRoot, "vendor/base.worker.js");

describe("stripXeroInjection", () => {
  it("removes legacy Xero tail from downloaded production snapshot", () => {
    const raw = fs.readFileSync(vendorBase, "utf8");
    const stripped = stripXeroInjection(raw);
    expect(stripped.includes("function __registerXeroReadTools")).toBe(false);
    expect(stripped.includes(XERO_INJECT_BEGIN)).toBe(false);
    expect(stripped.includes("var index_default = {")).toBe(true);
    expect(stripped.includes("registerXeroReadTools(server")).toBe(false);
  });

  it("detects duplicate Xero symbol registration in bundled output", () => {
    const bad = `
var index_default = { async fetch() {} };
function __registerXeroReadTools() {}
function __registerXeroReadTools() {}
${XERO_INJECT_BEGIN}
${XERO_INJECT_END}
export { index_default as default };
`;
    const result = assertNoDuplicateXeroSymbols(bad);
    expect(result.ok).toBe(false);
  });

  it("accepts a single injected registration block", () => {
    const good = `
var index_default = { async fetch() {} };
${XERO_INJECT_BEGIN}
function __registerXeroReadTools() {}
function __registerXeroWriteTools() {}
function registerXeroReadTools() {}
function registerXeroWriteTools() {}
${XERO_INJECT_END}
export { index_default as default };
`;
    const result = assertNoDuplicateXeroSymbols(good);
    expect(result.ok).toBe(true);
  });
});

describe("build-worker idempotency", () => {
  it("produces exactly one Xero registration surface after build", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("node", ["scripts/build-worker.mjs"], { cwd: pkgRoot, stdio: "pipe" });
    const first = fs.readFileSync(path.join(pkgRoot, "dist/worker.js"), "utf8");
    execFileSync("node", ["scripts/build-worker.mjs"], { cwd: pkgRoot, stdio: "pipe" });
    const second = fs.readFileSync(path.join(pkgRoot, "dist/worker.js"), "utf8");
    expect(first).toBe(second);
    expect((first.match(/\bfunction __registerXeroReadTools\b/g) ?? []).length).toBe(1);
    expect((first.match(/\bfunction registerXeroReadTools\b/g) ?? []).length).toBe(1);
    expect(first.includes(XERO_INJECT_BEGIN)).toBe(true);
    expect(first.includes(XERO_INJECT_END)).toBe(true);
  });

  it("does not embed raw JSON Schema inside Zod raw-shape tool registrations", () => {
    const worker = fs.readFileSync(path.join(pkgRoot, "dist/worker.js"), "utf8");
    const marker = 'function __registerXeroWriteTools';
    const writeFnStart = worker.indexOf(marker);
    expect(writeFnStart).toBeGreaterThan(0);
    const writeToolBlock = worker.slice(writeFnStart, writeFnStart + 1500);
    expect(writeToolBlock.includes('type: "array"')).toBe(false);
    expect(writeToolBlock.includes("minItems:")).toBe(false);
    expect(writeToolBlock.includes("zf.array(")).toBe(true);
  });

  it("patches uploadKnowledgeDocument for external_id idempotency", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("node", ["scripts/build-worker.mjs"], { cwd: pkgRoot, stdio: "pipe" });
    const worker = fs.readFileSync(path.join(pkgRoot, "dist/worker.js"), "utf8");
    expect(worker.includes('action: "existing"')).toBe(true);
    expect(worker.includes("SELECT id FROM knowledge_documents WHERE external_id = ?")).toBe(true);
  });
});
