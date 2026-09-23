/** Only continue to INFRA OAuth authorize after portal login. */
export function safeOauthContinueUrl(next: string | null | undefined): string | null {
  if (!next?.trim()) return null;
  const value = next.trim();
  if (value.startsWith("/oauth/authorize")) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.pathname !== "/oauth/authorize") return null;
    const host = url.hostname.toLowerCase();
    // Resume on the portal origin so the session cookie is sent.
    // workers.dev / api.infrastack.app continue URLs caused a post-login 404.
    if (
      host.endsWith(".workers.dev") ||
      host === "api.infrastack.app" ||
      host === "mcp.infrastack.app"
    ) {
      return `${url.pathname}${url.search}`;
    }
    if (
      host === "app.infrastack.app" ||
      host === "infrastack.app" ||
      host.endsWith(".infrastack.app") ||
      host.endsWith(".infra-web.pages.dev") ||
      host === "localhost" ||
      host === "127.0.0.1"
    ) {
      return `${url.pathname}${url.search}`;
    }
  } catch {
    return null;
  }
  return null;
}
