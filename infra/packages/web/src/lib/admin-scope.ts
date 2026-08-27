/** How company scope applies to a Control Plane route. */
export type ScopePageMode = "filterable" | "platform-only";

const PLATFORM_ONLY_PREFIXES = [
  "/commercial/provider-costs",
  "/settings",
] as const;

/** Routes where scope filters list data (platform-wide when no company selected). */
export function getPageScopeMode(pathname: string): ScopePageMode {
  for (const prefix of PLATFORM_ONLY_PREFIXES) {
    if (pathname.startsWith(prefix)) return "platform-only";
  }
  return "filterable";
}

export function scopeModeLabel(mode: ScopePageMode): string {
  return mode === "platform-only"
    ? "Platform-wide view — company scope does not apply on this page"
    : "Company scope filters data on this page when a tenant is selected";
}
