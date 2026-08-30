import type { Env } from "../env";
import type { ElvexActor } from "../rbac/actor";
import { infraUsageUrl } from "../oauth/config";
import { ELVEX_COMPANY_ID, ELVEX_COMPANY_SLUG } from "../rbac/actor";

export function inferConnectorFromTool(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n.includes("xero")) return "xero";
  if (
    n.includes("mail") ||
    n.includes("outlook") ||
    n.includes("calendar") ||
    n.includes("onedrive") ||
    n.includes("sharepoint") ||
    n.includes("microsoft")
  ) {
    return "microsoft";
  }
  if (n.includes("knowledge") || n === "search" || n === "fetch" || n === "database_summary") {
    return "knowledge";
  }
  return "company_mcp";
}

export async function reportInfraMcpUsage(
  env: Env,
  input: {
    actor: ElvexActor;
    toolName: string;
    success: boolean;
    durationMs: number;
    correlationId?: string | null;
    requestId?: string | null;
    client?: string | null;
  }
): Promise<{ ok: boolean; skipped?: string }> {
  const url = infraUsageUrl(env);
  if (!url) return { ok: false, skipped: "infra_usage_url_missing" };
  const bearer = env.MCP_AUTH_TOKEN?.trim() || env.INFRA_MCP_INTERNAL_SECRET?.trim();
  if (!bearer) return { ok: false, skipped: "mcp_auth_token_missing" };
  if (!input.actor.identityBound && input.actor.identitySource === "service_token") {
    return { ok: false, skipped: "service_token_not_human" };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        companyId: ELVEX_COMPANY_ID,
        companySlug: ELVEX_COMPANY_SLUG,
        userId: input.actor.identityBound ? input.actor.actorId : null,
        actorEmail: input.actor.email,
        sourceClient: input.client || "chatgpt",
        toolName: input.toolName,
        connector: inferConnectorFromTool(input.toolName),
        success: input.success,
        durationMs: input.durationMs,
        correlationId: input.correlationId,
        requestId: input.requestId,
        metadata: {
          identitySource: input.actor.identitySource,
          identityBound: input.actor.identityBound,
        },
      }),
    });
    return { ok: response.ok };
  } catch {
    return { ok: false, skipped: "usage_report_failed" };
  }
}

export async function peekToolsCall(request: Request): Promise<{ method: string | null; toolName: string | null }> {
  if (request.method !== "POST") return { method: null, toolName: null };
  try {
    const body = (await request.clone().json()) as {
      method?: unknown;
      params?: { name?: unknown };
    };
    return {
      method: typeof body.method === "string" ? body.method : null,
      toolName: typeof body.params?.name === "string" ? body.params.name : null,
    };
  } catch {
    return { method: null, toolName: null };
  }
}

export function usageSuccessFromMcpResponse(status: number, body: unknown): boolean {
  if (status >= 400) return false;
  if (!body || typeof body !== "object") return status < 400;
  const rpc = body as { error?: unknown; result?: { isError?: unknown } };
  if (rpc.error) return false;
  if (rpc.result?.isError === true) return false;
  return true;
}
