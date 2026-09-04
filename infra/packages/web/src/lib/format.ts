/**
 * INFRA presentation helpers — human labels, relative time, money.
 * Keeps technical IDs out of primary UI surfaces.
 */

import { classifyUsageOutcome, type UsageFailureCategory } from "@infra/shared";

export type { UsageFailureCategory };

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
  "company.suspended": "Company suspended",
  "company.reactivated": "Company reactivated",
  "company.archived": "Company archived",
  "ai_connection.created": "AI connection created",
  "ai_connection.revoked": "AI connection revoked",
  "user.role_changed": "User role changed",
  "wallet.adjusted": "Wallet adjusted",
  "pricing.changed": "Pricing changed",
  "user.created": "User invited",
  "user.disabled": "User disabled",
  "role.assigned": "Role assigned",
  "role.changed": "Role changed",
  "permission.denied": "Permission denied",
  "permission.updated": "Permissions updated",
  "credential.created": "Credential created",
  "credential.rotated": "Credential rotated",
  "credential.revoked": "Credential revoked",
  "billing.credit_adjusted": "Credit adjusted",
  "mcp.capabilities_refreshed": "Business MCP capabilities refreshed",
  "connector.setup_started": "Connector setup started",
  "connector.connected": "Connector connected",
  "connector.connection_failed": "Connector connection failed",
  "connector.reauthenticated": "Connector reconnected",
  "connector.disconnected": "Connector disconnected",
  "connector.credentials_rotated": "Connector credentials replaced",
  "payment.confirmed": "Payment confirmed",
  "wallet.credited": "Wallet credited",
  "refund.received": "Refund processed",
  "action_plan.created": "Action planned",
  "action_plan.confirmed": "Action confirmed",
  "action_plan.completed": "Action completed",
  "action_plan.execution_failed": "Action failed",
};

export function humanEventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType.replace(/\./g, " · ");
}

const PROBE_ACTOR_PATTERN = /\b(temp|probe|e2e|acceptance|readback|cleanup)\b/i;

/** Hide internal probe/service identity names from polished activity UI. */
export function humanActor(actor: string | null | undefined): string {
  if (!actor) return "System";
  const trimmed = actor.trim();
  if (!trimmed) return "System";
  if (PROBE_ACTOR_PATTERN.test(trimmed)) return "System automation";
  if (/^svc_probe_/i.test(trimmed) || /^TEMP\b/i.test(trimmed)) return "System automation";
  if (trimmed === "stripe-webhook") return "Stripe";
  if (/^chatgpt$/i.test(trimmed) || trimmed.includes("ChatGPT")) return "ChatGPT";
  if (/^claude$/i.test(trimmed) || trimmed.includes("Claude")) return "Claude";
  if (/^cursor$/i.test(trimmed) || trimmed.includes("cursor")) return "Cursor";
  if (trimmed.includes("@")) {
    const local = trimmed.split("@")[0] ?? trimmed;
    return local
      .split(/[._-]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  return trimmed;
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
    "customer.request": "Customer request",
    "knowledge.search": "Knowledge Search",
    "knowledge.read": "Knowledge Document Read",
    "system.health": "Connection check",
    search_company_knowledge: "Knowledge Search",
    get_knowledge_document: "Knowledge Document Read",
    search: "Knowledge Search",
    fetch: "Knowledge Document Read",
    database_summary: "Business data summary",
    system_health: "Connection check",
    "xero.contacts.search": "Search Xero contacts",
    "xero.invoices.search": "Search Xero invoices",
    "xero.invoices.get": "View Xero invoice",
    "xero.invoices.create": "Create Xero draft invoice",
    "xero.invoices.create_draft": "Create Xero draft invoice",
    "xero.organisation.read": "View Xero organisation",
    "xero.accounts.read": "View Xero accounts",
    "xero.reports.pnl.read": "Xero profit & loss report",
    xero_get_invoice: "View Xero invoice",
    xero_search_invoices: "Search Xero invoices",
    xero_list_contacts: "Search Xero contacts",
    plan_xero_draft_invoice: "Plan Xero draft invoice",
    execute_action_plan: "Execute approved action",
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
    "e2e-probe": "System",
    portal: "Portal",
    portal_chat: "Portal Chat",
    "action-engine": "INFRA",
  };
  if (!source) return "—";
  return map[source] ?? source;
}

export function classifyUsageFailure(input: {
  success?: boolean;
  action?: string | null;
  toolName?: string | null;
  settlementStatus?: string | null;
  durationMs?: number | null;
  recordedAt?: string | null;
  actorEmail?: string | null;
  metadata?: Record<string, unknown>;
}): UsageFailureCategory | null {
  return classifyUsageOutcome(input).failureCategory;
}

export function humanFailureCategory(category: UsageFailureCategory): string {
  const map: Record<UsageFailureCategory, string> = {
    AUTHENTICATION: "Authentication",
    PERMISSION: "Permission denied",
    MISSING_CAPABILITY: "Missing capability",
    VALIDATION: "Validation",
    UPSTREAM_API: "Upstream API",
    RATE_LIMIT: "Rate limit",
    TIMEOUT: "Timeout",
    INSUFFICIENT_CREDIT: "Insufficient credit",
    INFRA_INTERNAL: "INFRA internal",
    USER_INPUT: "User input",
    UNKNOWN: "Unknown",
  };
  return map[category];
}

export function integrationLabel(action?: string | null, toolName?: string | null): string {
  const key = `${action ?? ""} ${toolName ?? ""}`.toLowerCase();
  if (key.includes("xero")) return "Xero";
  if (key.includes("knowledge") || key.includes("search_company")) return "Knowledge";
  if (key.includes("bigchange")) return "BigChange";
  if (key.includes("commusoft")) return "Commusoft";
  if (key.includes("stripe") || key.includes("wallet")) return "Billing";
  return "INFRA";
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

/** Accessible status tones: blue=healthy, yellow=attention, red=failed, grey=neutral */
export function statusTone(value: string): string {
  const v = value.toLowerCase();
  if (
    [
      "healthy",
      "active",
      "connected",
      "completed",
      "success",
      "ok",
      "operational",
      "complete",
      "settled",
      "credited",
      "accepted",
    ].includes(v)
  ) {
    return "healthy";
  }
  if (
    [
      "degraded",
      "warning",
      "attention",
      "pending",
      "pending_approval",
      "canary",
      "applying",
      "low",
      "syncing",
      "onboarding",
      "test_mode",
      "draft",
      "expired",
    ].includes(v)
  ) {
    return "warning";
  }
  if (
    [
      "unreachable",
      "error",
      "failed",
      "suspended",
      "disabled",
      "offline",
      "closed",
      "critical",
    ].includes(v)
  ) {
    return "danger";
  }
  if (
    [
      "coming_soon",
      "not_configured",
      "unknown",
      "not_provisioned",
      "no",
      "unavailable",
      "not_live",
      "archived",
      "registered",
      "configured",
      "available",
      "cancelled",
    ].includes(v)
  ) {
    return "muted";
  }
  return "healthy";
}

export function statusIcon(tone: string): string {
  if (tone === "healthy") return "✓";
  if (tone === "warning") return "!";
  if (tone === "danger") return "×";
  return "–";
}

export function customerTaxonomyLabel(category: string): string {
  const map: Record<string, string> = {
    knowledge_sources: "Knowledge & Documents",
    accounting_finance: "Finance",
    field_service_crm: "CRM & Field Service",
    customer_support: "Customer Support",
    productivity: "Productivity",
    ai_connections: "AI",
    communication_channels: "Communications",
    custom_integrations: "Other",
  };
  return map[category] ?? category.replace(/_/g, " ");
}

export type ActionCentreBucket = "needs_approval" | "in_progress" | "completed" | "failed";

export function actionCentreBucket(status: string): ActionCentreBucket {
  if (status === "awaiting_approval") return "needs_approval";
  if (
    [
      "awaiting_confirmation",
      "validated",
      "approved",
      "executing",
      "draft",
    ].includes(status)
  ) {
    return "in_progress";
  }
  if (status === "completed") return "completed";
  return "failed";
}

export function planTargetsReady(plan: { targets: Array<{ validation?: string }> }): boolean {
  return plan.targets.length > 0 && plan.targets.every((target) => target.validation === "valid");
}

export function planIsConfirmable(plan: {
  status: string;
  targets: Array<{ validation?: string }>;
}): boolean {
  return plan.status === "awaiting_confirmation" && planTargetsReady(plan);
}

export function planIsApprovable(plan: {
  status: string;
  targets: Array<{ validation?: string }>;
}): boolean {
  return plan.status === "awaiting_approval" && planTargetsReady(plan);
}

export function planFailureDisplayReason(plan: {
  summary?: string | null;
  targets: Array<{ validation?: string; validationDetail?: string | null }>;
}): string | null {
  if (planTargetsReady(plan)) return null;
  const invalid = plan.targets.find((target) => target.validation !== "valid");
  if (invalid?.validationDetail) return invalid.validationDetail;
  if (plan.summary?.includes("plan failed")) {
    return plan.summary.replace(/^.*plan failed —\s*/i, "").replace(/\.$/, "") || plan.summary;
  }
  return invalid?.validation ?? "Planning failed";
}

export function humanActionStatus(status: string): string {
  const map: Record<string, string> = {
    draft: "Draft",
    validated: "Validated",
    awaiting_confirmation: "Awaiting confirmation",
    awaiting_approval: "Needs your approval",
    approved: "Approved",
    executing: "In progress",
    completed: "Completed",
    partial_failure: "Partially failed",
    failed: "Failed",
    rejected: "Rejected",
    cancelled: "Cancelled",
    expired: "Expired",
    plan_stale: "Out of date",
    execution_uncertain: "Needs attention",
  };
  return map[status] ?? status.replace(/_/g, " ");
}

export function humanConfirmationStatus(value: string): string {
  const map: Record<string, string> = {
    not_required: "Not required",
    awaiting: "Awaiting",
    confirmed: "Confirmed",
  };
  return map[value] ?? value.replace(/_/g, " ");
}

export function humanApprovalStatus(value: string): string {
  const map: Record<string, string> = {
    not_required: "Not required",
    pending: "Pending",
    approved: "Approved",
    denied: "Denied",
  };
  return map[value] ?? value.replace(/_/g, " ");
}

export function humanRiskClass(value: string): string {
  const map: Record<string, string> = {
    low_risk: "Low risk",
    write: "Data change",
    financial_action: "Financial action",
    external_send: "External send",
    delete: "Deletion",
  };
  return map[value] ?? value.replace(/_/g, " ");
}

export function humanScope(scope: string): string {
  const map: Record<string, string> = {
    "knowledge.search": "Search company knowledge",
    "knowledge.read": "Read company documents",
    "system.health": "Check connection health",
    "xero.organisation.read": "View organisation details",
    "xero.contacts.read": "View contacts",
    "xero.contacts.search": "Search contacts",
    "xero.invoices.read": "View invoices",
    "xero.invoices.search": "Search invoices",
    "xero.invoices.get": "View invoice details",
    "xero.invoices.create": "Create draft invoices",
    "xero.payments.read": "View payments",
    "xero.accounts.read": "View accounts",
    "xero.bank_transactions.read": "View bank transactions",
    "xero.reports.pnl.read": "View profit & loss",
    "xero.reports.balance_sheet.read": "View balance sheet",
    "xero.reports.aged.read": "View aged reports",
    "xero.action.plan": "Plan financial actions",
    "xero.action.read": "View planned actions",
    "xero.action.confirm": "Confirm planned actions",
    "xero.action.execute": "Execute approved actions",
    "xero.action.cancel": "Cancel planned actions",
    "xero.action.list": "List planned actions",
  };
  if (map[scope]) return map[scope];
  return scope.replace(/\./g, " · ").replace(/_/g, " ");
}

export function humanAuditDetail(event: {
  eventType: string;
  actor?: string | null;
  resourceType?: string | null;
  detail?: Record<string, unknown> | null;
}): string {
  const actor = humanActor(event.actor);
  const detail = event.detail ?? {};
  const client = detail.sourceClient ?? detail.client;
  const clientLabel =
    client === "chatgpt"
      ? "ChatGPT"
      : client === "claude"
        ? "Claude"
        : client
          ? humanClient(String(client))
          : null;
  const integration = integrationLabel(
    String(detail.action ?? detail.toolName ?? ""),
    event.resourceType ?? undefined,
  );
  if (clientLabel && integration !== "INFRA") {
    return `${actor} · ${clientLabel} · ${integration}`;
  }
  if (clientLabel) return `${actor} · ${clientLabel}`;
  if (event.resourceType) return `${actor} · ${event.resourceType.replace(/_/g, " ")}`;
  return actor;
}

export function humanConnectorPurpose(slug: string, fallback?: string): string {
  const map: Record<string, string> = {
    xero: "Accounting, invoices, contacts and payments",
    "google-drive": "Company documents available to INFRA",
    sharepoint: "Shared company documents and files",
    onedrive: "Shared company documents and files",
    outlook: "Shared mailbox messages and attachments",
    bigchange: "Jobs, schedules and field operations",
    commusoft: "Customers, jobs and service history",
    chatgpt: "Use ChatGPT securely with your connected systems",
    claude: "Use Claude securely with your connected systems",
    whatsapp: "Business messaging through the INFRA WhatsApp channel",
  };
  return map[slug] ?? fallback ?? "Connect this system to INFRA";
}

export function formatActionAmount(
  amount: number | null | undefined,
  currency = "GBP",
): string {
  if (amount == null) return "—";
  return formatMoney(Math.round(amount * 100), currency);
}

export function usageSuccessRate(successful: number, total: number): string {
  if (total <= 0) return "—";
  const pct = Math.round((successful / total) * 100);
  return `${pct}%`;
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
    accepted: "Accepted",
    cancelled: "Cancelled",
    expired: "Expired",
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
    onboarding: "Onboarding",
    archived: "Archived",
    closed: "Closed",
    ready_to_connect: "Ready to connect",
    unavailable: "Unavailable",
    not_provisioned: "Not provisioned",
    test_mode: "TEST mode",
    no: "No",
    complete: "Complete",
    authentication_required: "Authentication required",
    offline: "Offline",
    credentials_required: "Credentials required",
    auth_expired: "Authentication expired",
    rotation_required: "Rotation required",
    revoked: "Revoked",
    not_applicable: "Not applicable",
    optional: "Optional",
    required: "Required",
    pending_approval: "Pending approval",
    rejected_pretest: "Rejected in pretest",
    applying: "Applying",
    canary: "Canary",
    promoted: "Applied",
    rolled_back: "Rolled back",
    failed_validation: "Failed validation",
    auto_apply_safe: "Auto-apply safe",
    requires_engineering: "Needs engineering",
    informational: "Informational",
    historical: "Historical",
    current: "Current",
    recurrent: "Recurrent",
  };
  return map[value] ?? value.replace(/_/g, " ");
}
