/** Allow only same-app paths or INFRA OAuth authorize URLs. */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.pathname.startsWith("/oauth/mcp/authorize")) {
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}
