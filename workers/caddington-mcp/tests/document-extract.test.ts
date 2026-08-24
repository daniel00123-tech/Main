import { describe, expect, it } from "vitest";
import {
  isPlainTextDocument,
  isWorkersAiConvertible,
} from "../src/document-extract";

describe("document type detection", () => {
  it("detects plain text types", () => {
    expect(isPlainTextDocument("text/plain", "notes.txt")).toBe(true);
    expect(isPlainTextDocument("application/octet-stream", "readme.md")).toBe(
      true
    );
  });

  it("detects PDF and Word for Workers AI conversion", () => {
    expect(
      isWorkersAiConvertible("application/pdf", "policy.pdf")
    ).toBe(true);
    expect(
      isWorkersAiConvertible(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "handbook.docx"
      )
    ).toBe(true);
    expect(isWorkersAiConvertible("application/msword", "legacy.doc")).toBe(
      true
    );
  });

  it("does not treat plain text as AI convertible only", () => {
    expect(isWorkersAiConvertible("text/plain", "notes.txt")).toBe(false);
    expect(isPlainTextDocument("text/plain", "notes.txt")).toBe(true);
  });
});
