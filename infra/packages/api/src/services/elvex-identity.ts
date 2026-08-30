import { ELVEX_COMPANY_ID, ELVEX_COMPANY_SLUG, isElvexRole } from "@infra/shared";
import type { Env } from "../env";
import { resolveMcpFetcher } from "./mcp-client";

export async function elvexIdentityHeaders(
  secret: string | undefined,
  input: {
    actorId: string;
    email: string;
    displayName?: string | null;
    principalType?: "user" | "service";
    correlationId?: string | null;
  },
): Promise<Record<string, string>> {
  if (!secret?.trim()) return {};
  const timestamp = new Date().toISOString();
  const principalType = input.principalType ?? "user";
  const correlationId = input.correlationId ?? "";
  const payload = [
    input.actorId,
    input.email.toLowerCase(),
    principalType,
    timestamp,
    correlationId,
  ].join("\n");
  const signature = await hmacHex(secret, payload);
  return {
    "X-Elvex-Actor-Id": input.actorId,
    "X-Elvex-Actor-Email": input.email,
    "X-Elvex-Actor-Name": input.displayName ?? "",
    "X-Elvex-Principal-Type": principalType,
    "X-Elvex-Identity-Ts": timestamp,
    "X-Elvex-Correlation-Id": correlationId,
    "X-Elvex-Identity-Sig": signature,
  };
}

export function isElvexMcpCompany(company: { id?: string | null; slug?: string | null }): boolean {
  return company.id === ELVEX_COMPANY_ID || company.slug === ELVEX_COMPANY_SLUG;
}

export async function syncElvexCompanyUser(
  env: Env,
  input: {
    externalId: string;
    email: string;
    displayName?: string | null;
    role: string;
    status?: "active" | "disabled";
  },
): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  const secret = typeof env.EL_RBAC_IDENTITY_SECRET === "string" ? env.EL_RBAC_IDENTITY_SECRET.trim() : "";
  const adminToken =
    typeof env.EL_BUSINESS_MCP_ADMIN_TOKEN === "string" ? env.EL_BUSINESS_MCP_ADMIN_TOKEN.trim() : "";
  if (!secret || !adminToken) {
    return { ok: false, skipped: "EL_RBAC_IDENTITY_SECRET or EL_BUSINESS_MCP_ADMIN_TOKEN is not configured" };
  }
  if (!isElvexRole(input.role)) {
    return { ok: false, error: "Role is not a canonical Elvex role" };
  }
  const timestamp = new Date().toISOString();
  const status = input.status ?? "active";
  const signature = await hmacHex(
    secret,
    ["user-sync", input.externalId, input.email.toLowerCase(), input.role, status, timestamp].join("\n"),
  );
  const headers = {
    Authorization: `Bearer ${adminToken}`,
    "Content-Type": "application/json",
  };
  const body = JSON.stringify({
    externalId: input.externalId,
    email: input.email,
    displayName: input.displayName ?? null,
    role: input.role,
    status,
    timestamp,
    signature,
  });
  try {
    const binding = resolveMcpFetcher(env, "EL_BUSINESS_MCP");
    const request = new Request("https://company-mcp.internal/admin/rbac/sync-user", {
      method: "POST",
      headers,
      body,
    });
    const response = binding
      ? await binding.fetch(request)
      : await fetch("https://el-business-mcp.infrastack.app/admin/rbac/sync-user", {
          method: "POST",
          headers,
          body,
        });
    if (!response.ok) {
      return { ok: false, error: `EL MCP sync HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
