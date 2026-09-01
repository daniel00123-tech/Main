import { INFRA_MCP_ENDPOINT } from "@infra/shared";

/** Public API base — empty in dev (Vite proxy) and production (Pages same-origin /api proxy). */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

/** Canonical ChatGPT / Claude MCP connector URL. */
export function infraMcpGatewayUrl(): string {
  return INFRA_MCP_ENDPOINT;
}
