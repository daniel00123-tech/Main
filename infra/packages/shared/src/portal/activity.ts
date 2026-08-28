import type { AuditEvent } from "../types";

export type CustomerActivityItem = {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  tone: "healthy" | "warning" | "danger" | "muted";
};

const INTERNAL_ACTOR =
  /^(system:|svc_|internal-|probe|microsoft-scheduler|microsoft-queue|stripe-webhook)/i;

const HIDDEN_EVENTS = new Set([
  "company.accessed",
  "mcp.tools_listed",
  "mcp.health_checked",
  "connector.health_checked",
  "mcp.execution_succeeded",
  "connector.sync_started",
]);

function providerFromEvent(event: AuditEvent): string | null {
  const detail = event.detail ?? {};
  const provider = String(detail.provider ?? detail.connector ?? "").toLowerCase();
  if (provider.includes("microsoft") || provider.includes("m365")) return "Microsoft 365";
  if (provider.includes("google")) return "Google Drive";
  if (provider.includes("xero")) return "Xero";
  const blob = `${event.eventType} ${event.resourceId ?? ""} ${JSON.stringify(detail)}`.toLowerCase();
  if (blob.includes("microsoft") || blob.includes("m365")) return "Microsoft 365";
  if (blob.includes("google")) return "Google Drive";
  if (blob.includes("xero")) return "Xero";
  return null;
}

function humanActorName(actor: string): string {
  const trimmed = actor.trim();
  if (!trimmed || INTERNAL_ACTOR.test(trimmed)) return "System";
  if (/chatgpt/i.test(trimmed)) return "ChatGPT";
  if (/claude/i.test(trimmed)) return "Claude";
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

function mapEvent(event: AuditEvent): CustomerActivityItem | null {
  const actor = event.actor ?? "";
  const type = event.eventType as string;

  if (HIDDEN_EVENTS.has(type)) return null;
  if (INTERNAL_ACTOR.test(actor) && type !== "connector.sync_completed" && type !== "connector.sync_failed") {
    return null;
  }

  const provider = providerFromEvent(event);

  if (type === "connector.sync_completed") {
    return {
      id: event.id,
      title: provider ?? "Connected system",
      description: "Synced successfully",
      createdAt: event.createdAt,
      tone: "healthy",
    };
  }
  if (type === "connector.sync_failed") {
    return {
      id: event.id,
      title: provider ?? "Connected system",
      description: "Sync failed",
      createdAt: event.createdAt,
      tone: "danger",
    };
  }
  if (type === "auth.login") {
    return {
      id: event.id,
      title: humanActorName(actor),
      description: "Signed in",
      createdAt: event.createdAt,
      tone: "healthy",
    };
  }
  if (type === "auth.logout") {
    return {
      id: event.id,
      title: humanActorName(actor),
      description: "Signed out",
      createdAt: event.createdAt,
      tone: "muted",
    };
  }
  if (type.startsWith("billing.") || type.startsWith("wallet.") || type.startsWith("payment.")) {
    return {
      id: event.id,
      title: "Billing",
      description:
        type === "billing.credit_adjusted" || type === "wallet.adjusted"
          ? "Credit updated"
          : type.includes("credit") || type.includes("credited")
            ? "Credit added"
            : type.includes("payment") || type.includes("confirmed")
              ? "Payment received"
              : "Billing updated",
      createdAt: event.createdAt,
      tone: "healthy",
    };
  }
  if (type === "connector.connected") {
    return {
      id: event.id,
      title: provider ?? "Connected system",
      description: "Connected",
      createdAt: event.createdAt,
      tone: "healthy",
    };
  }
  if (type === "connector.disconnected") {
    return {
      id: event.id,
      title: provider ?? "Connected system",
      description: "Disconnected",
      createdAt: event.createdAt,
      tone: "warning",
    };
  }
  if (type === "user.created" || type === "user.disabled" || type === "role.changed" || type === "user.role_changed") {
    return {
      id: event.id,
      title: "Team",
      description:
        type === "user.created"
          ? "User invited"
          : type === "user.disabled"
            ? "User access removed"
            : "User role changed",
      createdAt: event.createdAt,
      tone: "muted",
    };
  }
  if (type.startsWith("action_plan.")) {
    return {
      id: event.id,
      title: "Approvals",
      description:
        type === "action_plan.completed"
          ? "Action completed"
          : type === "action_plan.execution_failed"
            ? "Action failed"
            : type === "action_plan.created"
              ? "Approval requested"
              : "Action updated",
      createdAt: event.createdAt,
      tone: type.includes("failed") ? "danger" : "healthy",
    };
  }
  if (type.startsWith("automation.")) {
    const name =
      typeof event.detail?.name === "string" ? String(event.detail.name) : "Automation";
    return {
      id: event.id,
      title: name,
      description:
        type === "automation.run_completed"
          ? "Automation completed"
          : type === "automation.run_failed"
            ? "Automation failed"
            : type === "automation.activated"
              ? "Automation activated"
              : type === "automation.paused"
                ? "Automation paused"
                : "Automation updated",
      createdAt: event.createdAt,
      tone: type.includes("failed") ? "danger" : "healthy",
    };
  }
  if (type === "mcp.execution_failed") {
    return {
      id: event.id,
      title: humanActorName(actor),
      description: "AI request failed",
      createdAt: event.createdAt,
      tone: "danger",
    };
  }

  if (INTERNAL_ACTOR.test(actor)) return null;

  return null;
}

function collapseNearDuplicates(items: CustomerActivityItem[]): CustomerActivityItem[] {
  const out: CustomerActivityItem[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.title === item.title &&
      prev.description === item.description &&
      Math.abs(new Date(prev.createdAt).getTime() - new Date(item.createdAt).getTime()) <
        15 * 60 * 1000
    ) {
      continue;
    }
    out.push(item);
  }
  return out;
}

/** Customer-facing recent activity for the company portal dashboard. */
export function buildCustomerActivityFeed(
  events: AuditEvent[],
  limit = 5,
): CustomerActivityItem[] {
  return buildCustomerActivityList(events, limit);
}

export type CustomerActivityFilter = "all" | "users" | "ai" | "connectors" | "billing" | "actions";

/** Full customer activity list with noise collapsed — for Activity page. */
export function buildCustomerActivityList(
  events: AuditEvent[],
  limit = 100,
): CustomerActivityItem[] {
  const mapped = events
    .map((event) => mapEvent(event))
    .filter((item): item is CustomerActivityItem => item !== null);

  return collapseNearDuplicates(mapped).slice(0, limit);
}

export function filterCustomerActivity(
  items: CustomerActivityItem[],
  filter: CustomerActivityFilter,
  query: string,
): CustomerActivityItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((item) => {
    const category = customerActivityFilterCategory(item);
    if (filter !== "all" && category !== filter) return false;
    if (!q) return true;
    return (
      item.title.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q)
    );
  });
}

export function customerActivityFilterCategory(item: CustomerActivityItem): CustomerActivityFilter {
  if (item.title === "Billing") return "billing";
  if (
    item.title === "Approvals" ||
    item.description.includes("Automation") ||
    item.description.includes("Approval")
  ) {
    return "actions";
  }
  if (
    item.description === "Signed in" ||
    item.description === "Signed out" ||
    item.title === "Team"
  ) {
    return "users";
  }
  if (item.description.includes("AI request")) return "ai";
  if (
    item.description === "Synced successfully" ||
    item.description === "Sync failed" ||
    item.description === "Connected" ||
    item.description === "Disconnected"
  ) {
    return "connectors";
  }
  return "all";
}
