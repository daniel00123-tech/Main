/** Public API base — empty in dev (Vite proxy) and production (Pages same-origin /api proxy). */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

export function infraMcpGatewayUrl(): string {
  return `${API_BASE}/api/gateway/v1/mcp`;
}
