/**
 * Folder-level scope rules for Microsoft 365 sources.
 */

export type FolderScopeMode = "all" | "include_paths" | "exclude_paths";

export type FolderScope = {
  mode: FolderScopeMode;
  includePaths: string[];
  excludePaths: string[];
};

export function parseFolderScope(input: {
  folderScopeMode?: string | null;
  folderIncludePathsJson?: string | null;
  folderExcludePathsJson?: string | null;
}): FolderScope {
  const mode = (input.folderScopeMode ?? "all") as FolderScopeMode;
  let includePaths: string[] = [];
  let excludePaths: string[] = [];
  try {
    if (input.folderIncludePathsJson) {
      const parsed = JSON.parse(input.folderIncludePathsJson);
      if (Array.isArray(parsed)) includePaths = parsed.map(String).filter(Boolean);
    }
  } catch {
    /* ignore malformed json */
  }
  try {
    if (input.folderExcludePathsJson) {
      const parsed = JSON.parse(input.folderExcludePathsJson);
      if (Array.isArray(parsed)) excludePaths = parsed.map(String).filter(Boolean);
    }
  } catch {
    /* ignore malformed json */
  }
  return { mode, includePaths, excludePaths };
}

export function serializeFolderScope(scope: FolderScope): {
  folderScopeMode: FolderScopeMode;
  folderIncludePathsJson: string | null;
  folderExcludePathsJson: string | null;
} {
  return {
    folderScopeMode: scope.mode,
    folderIncludePathsJson:
      scope.includePaths.length > 0 ? JSON.stringify(scope.includePaths) : null,
    folderExcludePathsJson:
      scope.excludePaths.length > 0 ? JSON.stringify(scope.excludePaths) : null,
  };
}

/** Normalise a folder path for comparison (no leading/trailing slashes, lowercase). */
export function normaliseFolderPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").toLowerCase();
}

/** True when a file's relative path is within the configured folder scope. */
export function pathMatchesFolderScope(relativePath: string, scope: FolderScope): boolean {
  const normalised = normaliseFolderPath(relativePath);
  if (scope.mode === "all") {
    if (scope.excludePaths.length === 0) return true;
    return !scope.excludePaths.some((p) => pathIsUnder(normalised, normaliseFolderPath(p)));
  }
  if (scope.mode === "include_paths") {
    if (scope.includePaths.length === 0) return false;
    return scope.includePaths.some((p) => pathIsUnder(normalised, normaliseFolderPath(p)));
  }
  if (scope.mode === "exclude_paths") {
    if (scope.excludePaths.length === 0) return true;
    return !scope.excludePaths.some((p) => pathIsUnder(normalised, normaliseFolderPath(p)));
  }
  return false;
}

function pathIsUnder(filePath: string, folderPath: string): boolean {
  if (!folderPath) return true;
  return filePath === folderPath || filePath.startsWith(`${folderPath}/`);
}
