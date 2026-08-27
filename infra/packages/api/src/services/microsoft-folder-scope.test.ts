import { describe, expect, it } from "vitest";
import {
  normaliseFolderPath,
  parseFolderScope,
  pathMatchesFolderScope,
  serializeFolderScope,
} from "./microsoft-folder-scope";

describe("microsoft folder scope", () => {
  it("parses include_paths scope from persisted json", () => {
    const scope = parseFolderScope({
      folderScopeMode: "include_paths",
      folderIncludePathsJson: '["INFRA Knowledge Test","Policies"]',
      folderExcludePathsJson: null,
    });
    expect(scope.mode).toBe("include_paths");
    expect(scope.includePaths).toEqual(["INFRA Knowledge Test", "Policies"]);
  });

  it("matches files under included folder paths", () => {
    const scope = parseFolderScope({
      folderScopeMode: "include_paths",
      folderIncludePathsJson: '["INFRA Knowledge Test"]',
    });
    expect(pathMatchesFolderScope("INFRA Knowledge Test/report.pdf", scope)).toBe(true);
    expect(pathMatchesFolderScope("Personal/notes.txt", scope)).toBe(false);
  });

  it("excludes paths when mode is exclude_paths", () => {
    const scope = parseFolderScope({
      folderScopeMode: "exclude_paths",
      folderExcludePathsJson: '["Private"]',
    });
    expect(pathMatchesFolderScope("Private/secret.pdf", scope)).toBe(false);
    expect(pathMatchesFolderScope("Work/report.pdf", scope)).toBe(true);
  });

  it("serialises scope for persistence", () => {
    const serialised = serializeFolderScope({
      mode: "include_paths",
      includePaths: ["INFRA Knowledge Test"],
      excludePaths: [],
    });
    expect(serialised.folderScopeMode).toBe("include_paths");
    expect(JSON.parse(serialised.folderIncludePathsJson!)).toEqual(["INFRA Knowledge Test"]);
  });

  it("normalises folder paths consistently", () => {
    expect(normaliseFolderPath("/INFRA Knowledge Test/")).toBe("infra knowledge test");
  });
});
