/**
 * INFRA presentation helpers — human labels, relative time, money.
 * Keeps technical IDs out of primary UI surfaces.
 */

const EVENT_LABELS: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "auth.login_failed": "Sign-in failed",
  "auth.password_setup_completed": "Password set",
  "auth.password_setup_failed": "Password setup failed",
  "mcp.execution_requested": "AI request started",
  "mcp.execution_succeeded": "AI request completed",
  "mcp.execution_failed": "AI request failed",
  "mcp.tools_listed": "Tools listed",
  "mcp.health_checked": "Connection health checked",
  "mcp.registered": "AI gateway registered",
  "mcp.updated": "AI gateway updated",
  "connector.accessed": "Integration accessed",
  "connector.instance_created": "Integration added",
  "connector.instance_updated": "Integration updated",
  "connector.sync_started": "Sync started",
  "connector.sync_completed": "Sync completed",
  "connector.sync_failed": "Sync failed",
  "company.accessed": "Company opened",
  "company.created": "Company created",
  "company.updated": "Company updated",
  "user.created": "User invited",
  "user.disabled": "User disabled",
  "role.assigned": "Role assigned",
  "role.changed": "Role changed",
  "permission.denied": "Permission denied",
  "permission.updated": "Permissions updated",
  "credential.created": "Credential created",
  "credential.rotated": "Credential rotated",
  "billing.credit_adjusted": "Credit adjusted",
};

export function humanEventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType.replace(/\./g, " · ");
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const diffMs = Date.now() - date.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return "Just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 14) return `${day}d ago`;
  return formatShortDate(iso);
}

export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatFullDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatMoney(
  cents: number,
  currency = "GBP",
  opts?: { signed?: boolean },
): string {
  const value = cents / 100;
  const formatted = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
  }).format(Math.abs(value));
  if (!opts?.signed) return cents < 0 ? `-${formatted}` : formatted;
  if (cents > 0) return `+${formatted}`;
  if (cents < 0) return `-${formatted}`;
  return formatted;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-GB").format(value);
}

export function humanRole(role: string | null | undefined): string {
  if (!role) return "—";
  return role
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function humanLedgerType(type: string): string {
  const map: Record<string, string> = {
    top_up: "Credit added",
    credit: "Credit added",
    promotional_credit: "Opening / test credit",
    manual_credit: "Manual credit",
    usage: "Usage charge",
    usage_debit: "Usage charge",
    debit: "Usage charge",
    refund: "Refund",
    adjustment: "Adjustment",
  };
  return map[type] ?? type.replace(/_/g, " ");
}

export function humanOperation(action?: string | null, toolName?: string | null): string {
  const key = action ?? toolName ?? "";
  const map: Record<string, string> = {
    "knowledge.search": "Knowledge search",
    "knowledge.read": "Knowledge read",
    "system.health": "Connection check",
    search_company_knowledge: "Knowledge search",
    get_knowledge_document: "Knowledge read",
    database_summary: "Business data summary",
    system_health: "Connection check",
  };
  if (map[key]) return map[key];
  if (!key) return "Request";
  return key.replace(/[._]/g, " ");
}

export function humanClient(source?: string | null): string {
  const map: Record<string, string> = {
    chatgpt: "ChatGPT",
    claude: "Claude",
    whatsapp: "WhatsApp",
    "infra-mcp": "INFRA",
    "infra-gateway": "INFRA",
  };
  if (!source) return "—";
  return map[source] ?? source;
}

export function formatCharge(cents: number | null | undefined, currency = "GBP"): string {
  if (cents == null) return "—";
  return formatMoney(cents, currency);
}

export function greetingForNow(name?: string): string {
  const hour = new Date().getHours();
  const part =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = name?.split(" ")[0];
  return first ? `${part}, ${first}` : part;
}

/** Status vocabulary for badges — keep meanings distinct. */
export type InfraStatusKind =
  | "active"
  | "connected"
  | "available"
  | "coming_soon"
  | "healthy"
  | "degraded"
  | "unreachable"
  | "pending"
  | "disabled"
  | "not_configured"
  | "failed"
  | "draft"
  | "registered"
  | "configured"
  | "syncing"
  | "error"
  | "unknown"
  | "suspended"
  | "provisioning";

export function statusTone(value: string): string {
  const v = value.toLowerCase();
  if (["healthy", "active", "connected", "completed", "success", "ok", "operational"].includes(v)) {
    return "success";
  }
  if (["degraded", "warning", "pending", "registered", "configured", "available", "syncing"].includes(v)) {
    return "warning";
  }
  if (
    ["unreachable", "error", "failed", "suspended", "disabled"].includes(v)
  ) {
    return "danger";
  }
  if (["coming_soon", "draft", "not_configured", "unknown"].includes(v)) {
    return "muted";
  }
  return "info";
}

export function humanStatus(value: string): string {
  const map: Record<string, string> = {
    healthy: "Healthy",
    operational: "Operational",
    active: "Active",
    connected: "Connected",
    available: "Available",
    coming_soon: "Coming soon",
    degraded: "Degraded",
    unreachable: "Unavailable",
    pending: "Pending",
    disabled: "Disabled",
    not_configured: "Not configured",
    failed: "Failed",
    completed: "Completed",
    draft: "Not set up",
    registered: "Registered",
    configured: "Configured",
    not_live: "Not live",
    syncing: "Syncing",
    error: "Error",
    unknown: "Unknown",
    suspended: "Suspended",
    provisioning: "Provisioning",
    ready_to_connect: "Ready to connect",
    unavailable: "Unavailable",
  };
  return map[value] ?? value.replace(/_/g, " ");
}
