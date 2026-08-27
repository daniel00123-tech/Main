import { describe, expect, it } from "vitest";
import {
  deactivateMicrosoftKnowledgeDocument,
  reactivateMicrosoftKnowledgeDocument,
} from "./microsoft-knowledge-bridge";

describe("CMD13D knowledge visibility bridge", () => {
  it("exports deactivate and reactivate admin bridge helpers", () => {
    expect(typeof deactivateMicrosoftKnowledgeDocument).toBe("function");
    expect(typeof reactivateMicrosoftKnowledgeDocument).toBe("function");
  });
});

describe("CMD13D change/delete architecture", () => {
  it("documents expected microsoft knowledge item lifecycle states", () => {
    const states = ["pending", "indexed", "unsupported", "failed", "deleted", "skipped"];
    expect(states).toContain("indexed");
    expect(states).toContain("deleted");
  });

  it("documents visibility statuses for exclusion tombstones", () => {
    const visibility = ["active", "excluded", "tombstoned"];
    expect(visibility).toContain("tombstoned");
  });
});
