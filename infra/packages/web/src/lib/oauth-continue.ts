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
    if (
      host === "app.infrastack.app" ||
      host.endsWith(".infrastack.app") ||
      host.endsWith(".workers.dev") ||
      host === "localhost" ||
      host === "127.0.0.1"
    ) {
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}
