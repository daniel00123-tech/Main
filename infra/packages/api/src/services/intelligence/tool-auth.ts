import { elvexAllowsAction, isElvexRole } from "@infra/shared";
import { INTELLIGENCE_TOOL_NAMES, permittedToolsForConnectors } from "./catalogue.js";
import { isPrivateBusinessWebQuery, sanitisePublicWebQuery } from "./web-search.js";
import type { IntelligenceToolCall } from "./types.js";

export type ToolAuthContext = {
  role?: string | null;
  companyId?: string | null;
  connectors: string[];
  permittedTools: string[];
  channel?: string | null;
};

export type ToolAuthDecision = {
  allowed: boolean;
  reason: string;
  capability: string | null;
};

const WRITE_TOOLS =
  /^(xero_(create|update|approve|send|void|allocate)|outlook_(send|draft|create|reply|forward|delete))/i;

export function buildAllowedToolCatalogue(input: {
  role?: string | null;
  companyId?: string | null;
  connectors?: string[] | null;
  channel?: string | null;
}): string[] {
  const connectors = input.connectors ?? [];
  const byConnector = permittedToolsForConnectors(connectors);
  if (!isElvexRole(input.role)) return byConnector;
  return byConnector.filter((name) => authorizeNamedTool(name, input.role, null).allowed);
}

export function authorizeToolCall(ctx: ToolAuthContext, call: IntelligenceToolCall): ToolAuthDecision {
  const name = String(call.name ?? "").trim();
  if (!name) return { allowed: false, reason: "missing_tool_name", capability: null };
  if (WRITE_TOOLS.test(name)) {
    return { allowed: false, reason: "writes_forbidden", capability: null };
  }
  if (!INTELLIGENCE_TOOL_NAMES.has(name)) {
    return { allowed: false, reason: "unknown_tool", capability: null };
  }
  if (ctx.permittedTools.length && !ctx.permittedTools.includes(name)) {
    return { allowed: false, reason: "not_in_preauth_catalogue", capability: capabilityForTool(name) };
  }
  if (name === "web_search") {
    const query = sanitisePublicWebQuery(String(call.arguments.query ?? call.arguments.q ?? ""));
    if (isPrivateBusinessWebQuery(query)) {
      return { allowed: false, reason: "private_systems_outrank_public_web", capability: "web.public" };
    }
    return { allowed: true, reason: "public_web", capability: "web.public" };
  }
  return authorizeNamedTool(name, ctx.role, mailboxFrom(call.arguments));
}

export function deniedToolResult(call: IntelligenceToolCall, decision: ToolAuthDecision) {
  if (decision.reason === "private_systems_outrank_public_web") {
    return {
      name: call.name,
      ok: false as const,
      latencyMs: 0,
      data: { error: "private_systems_outrank_public_web", reason: decision.reason },
      error: "private_systems_outrank_public_web",
    };
  }
  return {
    name: call.name,
    ok: false as const,
    latencyMs: 0,
    data: { error: "permission_denied", reason: decision.reason, accessOutcome: "permission_denied" },
    error: "permission_denied",
  };
}

function authorizeNamedTool(name: string, role: string | null | undefined, mailbox: string | null): ToolAuthDecision {
  if (!isElvexRole(role)) {
    return { allowed: true, reason: "role_not_elvex_bundle", capability: capabilityForTool(name) };
  }
  if (name.startsWith("xero_") || name.startsWith("warehouse_")) {
    const mapped = elvexAllowsAction(role, name, { toolName: name });
    return {
      allowed: mapped.allowed,
      reason: mapped.allowed ? "xero_granted" : mapped.reason ?? "xero_denied",
      capability: mapped.capability,
    };
  }
  if (name.startsWith("outlook_")) {
    const mapped = elvexAllowsAction(role, name, { toolName: name, mailboxAddress: mailbox });
    if (!mapped.allowed && mailbox) {
      return { allowed: false, reason: mapped.reason ?? "mailbox_denied", capability: mapped.capability };
    }
    if (!mapped.allowed && !mailbox) {
      const info = elvexAllowsAction(role, name, {
        toolName: name,
        mailboxAddress: "info@elvexpropertyservices.com",
      });
      return {
        allowed: info.allowed,
        reason: info.allowed ? "info_mailbox_default" : info.reason ?? "mailbox_denied",
        capability: info.capability,
      };
    }
    return {
      allowed: mapped.allowed,
      reason: mapped.allowed ? "mailbox_granted" : mapped.reason ?? "mailbox_denied",
      capability: mapped.capability,
    };
  }
  if (isKnowledgeTool(name)) {
    const mapped = elvexAllowsAction(role, "knowledge.read");
    return {
      allowed: mapped.allowed,
      reason: mapped.allowed ? "knowledge_granted" : mapped.reason ?? "knowledge_denied",
      capability: mapped.capability,
    };
  }
  return { allowed: true, reason: "company_read", capability: "system.health" };
}

function isKnowledgeTool(name: string): boolean {
  return (
    name === "search_company_knowledge" ||
    name === "search_document" ||
    name === "get_knowledge_document" ||
    name === "list_documents" ||
    name === "search" ||
    name === "fetch"
  );
}

function capabilityForTool(name: string): string | null {
  if (name.startsWith("xero_") || name.startsWith("warehouse_")) return "xero";
  if (name.startsWith("outlook_")) return "outlook";
  if (isKnowledgeTool(name)) return "knowledge";
  if (name === "web_search") return "web.public";
  return "company";
}

function mailboxFrom(args?: Record<string, unknown> | null): string | null {
  const raw = String(args?.mailboxAddress ?? args?.mailbox ?? "").trim();
  return raw || null;
}
