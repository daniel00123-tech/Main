import { INFRA_API_ORIGIN, INFRA_MCP_ENDPOINT } from "@infra/shared";

type RuntimeEnv = {
  VITE_API_BASE?: string;
  PROD?: boolean;
};

export function resolveApiBase(env: RuntimeEnv): string {
  const configured = env.VITE_API_BASE?.trim().replace(/\/$/, "");
  if (configured) return configured;
  return env.PROD ? INFRA_API_ORIGIN : "";
}

/** Public API base. Production must call the API host, not Cloudflare Pages. */
export const API_BASE = resolveApiBase(import.meta.env);

/** Canonical ChatGPT / Claude MCP connector URL. */
export function infraMcpGatewayUrl(): string {
  return INFRA_MCP_ENDPOINT;
}
