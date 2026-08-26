/** Public API base — empty in dev (Vite proxy). Override with VITE_API_BASE at build. */
const DEFAULT_PROD_API_BASE = "https://infra-api.daniel-dwyer123.workers.dev";

export const API_BASE = (
  import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? "" : DEFAULT_PROD_API_BASE)
).replace(/\/$/, "");

export function infraMcpGatewayUrl(): string {
  return `${API_BASE}/api/gateway/v1/mcp`;
}
