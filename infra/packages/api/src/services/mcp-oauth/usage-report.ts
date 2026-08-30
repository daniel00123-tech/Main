import type { Env } from "../../env";
import {
  getCompanyById,
  getCompanyBySlug,
  listConnectorInstances,
  listMcpEnvironments,
  recordAuditEvent,
} from "../control-plane";
import { recordUsageEvent } from "../usage";
import { timingSafeEqual } from "./crypto";

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

export type CompanyMcpUsageInput = {
  companyId?: string | null;
  companySlug?: string | null;
  userId?: string | null;
  actorEmail?: string | null;
  sourceClient?: string | null;
  toolName: string;
  connector?: string | null;
  success: boolean;
  durationMs?: number | null;
  correlationId?: string | null;
  requestId?: string | null;
  mcpEnvironmentId?: string | null;
  metadata?: Record<string, unknown>;
};

function extractBearer(header: string | null): string | null {
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

export async function authenticateCompanyMcpCaller(
  env: Env,
  request: Request,
  companyId: string,
): Promise<{ ok: true; mcpId: string | null } | { ok: false; status: 401 | 403; error: string }> {
  const bearer = extractBearer(request.headers.get("Authorization"));
  if (!bearer) return { ok: false, status: 401, error: "Bearer token required" };

  const internal = typeof env.INFRA_MCP_INTERNAL_SECRET === "string" ? env.INFRA_MCP_INTERNAL_SECRET.trim() : "";
  if (internal && timingSafeEqual(bearer, internal)) {
    return { ok: true, mcpId: null };
  }

  const mcps = await listMcpEnvironments(env.DB, companyId);
  const mcp = mcps[0] ?? null;
  const secretRef = mcp?.authSecretRef?.trim();
  const expected = secretRef && typeof env[secretRef] === "string" ? String(env[secretRef]).trim() : "";
  if (!expected || !timingSafeEqual(bearer, expected)) {
    return { ok: false, status: 401, error: "Invalid company MCP credential" };
  }
  return { ok: true, mcpId: mcp?.id ?? null };
}

export async function recordCompanyMcpUsage(
  env: Env,
  input: CompanyMcpUsageInput,
) {
  const company =
    (input.companyId ? await getCompanyById(env.DB, input.companyId) : null) ??
    (input.companySlug ? await getCompanyBySlug(env.DB, input.companySlug) : null);
  if (!company) {
    return { ok: false as const, error: "Company not found" };
  }

  const connector = input.connector?.trim() || inferConnectorFromTool(input.toolName);
  let connectorInstanceId: string | null = null;
  try {
    const instances = await listConnectorInstances(env.DB, company.id);
    const match = instances.find((item) => {
      const hay = `${item.connectorDefinitionId ?? ""} ${item.name ?? ""}`.toLowerCase();
      return hay.includes(connector);
    });
    connectorInstanceId = match?.id ?? null;
  } catch {
    connectorInstanceId = null;
  }

  const correlationId = input.correlationId?.trim() || null;
  const requestId = input.requestId?.trim() || correlationId;
  const usage = await recordUsageEvent(env.DB, {
    companyId: company.id,
    userId: input.userId ?? null,
    actorEmail: input.actorEmail ?? null,
    resourceType: "mcp",
    resourceId: input.toolName,
    mcpEnvironmentId: input.mcpEnvironmentId ?? null,
    connectorInstanceId,
    toolName: input.toolName,
    action: `mcp.${input.toolName}`,
    riskClass: "low_risk",
    success: input.success,
    durationMs: input.durationMs ?? null,
    sourceClient: input.sourceClient ?? "chatgpt",
    correlationId,
    requestId,
    metadata: {
      connector,
      reportedBy: "company_mcp",
      ...(input.metadata ?? {}),
    },
  });

  await recordAuditEvent(env.DB, {
    companyId: company.id,
    eventType: input.success ? "mcp.tool.succeeded" : "mcp.tool.denied",
    actor: input.actorEmail ?? input.userId ?? "mcp",
    resourceType: "mcp",
    resourceId: input.toolName,
    detail: {
      sourceClient: input.sourceClient ?? "chatgpt",
      connector,
      success: input.success,
      correlationId,
      requestId,
    },
  });

  return { ok: true as const, usage, companyId: company.id };
}
