import type { ConnectorInstance } from "@infra/shared";
import { listConnectorInstances, listMcpEnvironments } from "./control-plane";
import { deriveAuthStatus } from "./connector-lifecycle";
import { getWalletBalance } from "./ledger";
import { listServiceIdentities } from "./service-identities";

export type AttentionSeverity = "critical" | "warning" | "info";

export type AttentionItem = {
  id: string;
  severity: AttentionSeverity;
  category:
    | "mcp"
    | "connector"
    | "wallet"
    | "onboarding"
    | "ai_identity"
    | "company_status"
    | "billing"
    | "platform";
  companyId: string | null;
  companyName: string | null;
  companySlug: string | null;
  title: string;
  detail: string;
  href: string | null;
};

function connectorNeedsAttention(instance: ConnectorInstance): string | null {
  const authStatus = deriveAuthStatus(instance);
  if (authStatus === "auth_expired") return "Authentication expired";
  if (authStatus === "rotation_required") return "Re-authentication required";
  if (instance.status === "error") return instance.lastErrorMessage ?? "Connector error";
  if (instance.status === "degraded" || instance.healthStatus === "degraded") {
    return instance.lastErrorMessage ?? "Connector degraded";
  }
  if (authStatus === "revoked" && instance.status !== "draft") {
    return "Disconnected";
  }
  return null;
}

export async function buildPlatformAttention(
  db: D1Database,
  input?: { stripeConfigured?: boolean },
): Promise<AttentionItem[]> {
  const [companiesRows, mcps, connectors] = await Promise.all([
    db.prepare(`SELECT id, name, slug, status FROM companies ORDER BY name ASC`).all(),
    listMcpEnvironments(db),
    listConnectorInstances(db),
  ]);

  const companies = (companiesRows.results ?? []) as Array<{
    id: string;
    name: string;
    slug: string;
    status: string;
  }>;
  const companyById = new Map(companies.map((c) => [c.id, c]));
  const items: AttentionItem[] = [];

  for (const mcp of mcps) {
    if (!["degraded", "unreachable"].includes(mcp.status)) continue;
    const co = companyById.get(mcp.companyId);
    items.push({
      id: `mcp-${mcp.id}`,
      severity: mcp.status === "unreachable" ? "critical" : "warning",
      category: "mcp",
      companyId: mcp.companyId,
      companyName: co?.name ?? null,
      companySlug: co?.slug ?? null,
      title: `Business MCP ${mcp.status}`,
      detail: mcp.healthMessage ?? mcp.lastError ?? mcp.name,
      href: co ? `/companies/${co.slug}` : "/mcp-environments",
    });
  }

  for (const instance of connectors) {
    const reason = connectorNeedsAttention(instance);
    if (!reason) continue;
    const co = companyById.get(instance.companyId);
    const authStatus = deriveAuthStatus(instance);
    items.push({
      id: `conn-${instance.id}`,
      severity: authStatus === "auth_expired" ? "critical" : "warning",
      category: "connector",
      companyId: instance.companyId,
      companyName: co?.name ?? null,
      companySlug: co?.slug ?? null,
      title: `${instance.name} needs attention`,
      detail: reason,
      href: co ? `/portal/${co.slug}/connectors` : "/connectors",
    });
  }

  for (const co of companies) {
    if (co.status === "suspended") {
      items.push({
        id: `co-suspended-${co.id}`,
        severity: "critical",
        category: "company_status",
        companyId: co.id,
        companyName: co.name,
        companySlug: co.slug,
        title: "Company suspended",
        detail: "AI operations and writes are blocked until reactivation.",
        href: `/companies/${co.slug}`,
      });
    }

    const wallet = await getWalletBalance(db, co.id);
    if (wallet.lowBalance) {
      items.push({
        id: `wallet-${co.id}`,
        severity: "warning",
        category: "wallet",
        companyId: co.id,
        companyName: co.name,
        companySlug: co.slug,
        title: "Low wallet balance",
        detail: `${wallet.balanceCents}p remaining (threshold ${wallet.lowBalanceThresholdCents}p)`,
        href: `/portal/${co.slug}/billing`,
      });
    }

    const companyMcps = mcps.filter((m) => m.companyId === co.id);
    if (co.status === "onboarding" && companyMcps.length === 0) {
      items.push({
        id: `onboarding-mcp-${co.id}`,
        severity: "warning",
        category: "onboarding",
        companyId: co.id,
        companyName: co.name,
        companySlug: co.slug,
        title: "Onboarding incomplete — no Business MCP",
        detail: "Register an existing company MCP before this tenant can serve AI requests.",
        href: `/companies/${co.slug}`,
      });
    }

    const identities = await listServiceIdentities(db, co.id);
    const activeTokens = identities.filter((i) => i.status === "active" && i.hasToken).length;
    if (activeTokens === 0 && co.status === "active") {
      items.push({
        id: `ai-none-${co.id}`,
        severity: "info",
        category: "ai_identity",
        companyId: co.id,
        companyName: co.name,
        companySlug: co.slug,
        title: "No active AI connection",
        detail: "Create a ChatGPT or Claude service identity when ready.",
        href: `/portal/${co.slug}/ai-connections`,
      });
    }
  }

  const stripeOk = input?.stripeConfigured ?? false;
  if (!stripeOk) {
    items.push({
      id: "platform-stripe",
      severity: "info",
      category: "billing",
      companyId: null,
      companyName: null,
      companySlug: null,
      title: "Stripe not configured",
      detail: "Paid wallet top-ups are unavailable until STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set.",
      href: "/billing",
    });
  }

  return items.sort((a, b) => {
    const rank = { critical: 0, warning: 1, info: 2 };
    return rank[a.severity] - rank[b.severity];
  });
}

export async function buildCompanyAttention(
  db: D1Database,
  companyId: string,
): Promise<AttentionItem[]> {
  const all = await buildPlatformAttention(db, { stripeConfigured: false });
  return all.filter((item) => item.companyId === companyId);
}

export { connectorNeedsAttention };
