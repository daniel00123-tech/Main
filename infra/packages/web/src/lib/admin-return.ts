const BLOCKED = new Set(["/login", "/portal/login", "/forgot-password", "/setup-password"]);

/** Same-origin admin path + query. Rejects protocol-relative and off-site URLs. */
export function safeAdminReturnPath(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const value = raw.trim();
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("://")) return null;
  const [path, search = ""] = value.split("?");
  if (!path || BLOCKED.has(path) || path.startsWith("/portal/login")) return null;
  if (path.startsWith("/oauth/")) return null;
  const allowedSearch = search ? `?${search}` : "";
  return `${path}${allowedSearch}`;
}
