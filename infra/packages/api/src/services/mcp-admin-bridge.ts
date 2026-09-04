/**
 * Resolve MCP admin authentication for /admin/knowledge/* bridge calls.
 * Prefers per-environment admin_secret_ref; falls back to legacy CADDINGTON_ADMIN_TOKEN.
 */

import type { Env } from "../env";
import type { McpEnvironment } from "@infra/shared";
import { normalizeMcpAuthToken } from "./mcp-client";

export function resolveMcpAdminAuthHeader(
  env: Env,
  mcp: McpEnvironment,
): { authorizationHeader: string | null; source: string | null } {
  const refs: Array<{ ref: string; source: string }> = [];
  if (mcp.adminSecretRef) {
    refs.push({ ref: mcp.adminSecretRef, source: mcp.adminSecretRef });
  }
  if (mcp.serviceBindingRef === "EL_BUSINESS_MCP") {
    refs.push({ ref: "EL_BUSINESS_MCP_ADMIN_TOKEN", source: "EL_BUSINESS_MCP_ADMIN_TOKEN" });
    refs.push({ ref: "EL_MCP_AUTH_TOKEN", source: "EL_MCP_AUTH_TOKEN" });
  }
  if (mcp.serviceBindingRef === "HT_BUSINESS_MCP") {
    refs.push({ ref: "HT_BUSINESS_MCP_ADMIN_TOKEN", source: "HT_BUSINESS_MCP_ADMIN_TOKEN" });
    refs.push({ ref: "HT_MCP_AUTH_TOKEN", source: "HT_MCP_AUTH_TOKEN" });
  }
  // Legacy fallback — Caddington production bridge until admin_secret_ref seeded per MCP.
  refs.push({ ref: "CADDINGTON_ADMIN_TOKEN", source: "CADDINGTON_ADMIN_TOKEN" });

  for (const candidate of refs) {
    const secretValue = (env as Record<string, unknown>)[candidate.ref];
    if (typeof secretValue === "string" && secretValue.trim()) {
      const token = normalizeMcpAuthToken(secretValue);
      if (token) {
        return {
          authorizationHeader: `Bearer ${token}`,
          source: candidate.source,
        };
      }
    }
  }

  return { authorizationHeader: null, source: null };
}
