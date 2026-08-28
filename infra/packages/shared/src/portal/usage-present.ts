import type { UsageInteraction } from "../types";

export type UsageSpendCategory = "ai" | "automations" | "other";

export type UsageSpendSummary = {
  totalCents: number;
  aiCents: number;
  automationsCents: number;
  otherCents: number;
  requestCount: number;
};

export function usageClientCategory(clientKind: string): UsageSpendCategory {
  const kind = clientKind.toLowerCase();
  if (["chatgpt", "claude", "infra-mcp", "infra-gateway", "whatsapp"].includes(kind)) {
    return "ai";
  }
  if (["action-engine", "automation", "automations"].includes(kind)) {
    return "automations";
  }
  return "other";
}

/** Aggregate genuine customer charges from existing interaction rollups — no fabricated costs. */
export function buildUsageSpendSummary(
  interactions: UsageInteraction[],
  monthStartIso?: string,
): UsageSpendSummary {
  const monthStart = monthStartIso ? new Date(monthStartIso).getTime() : null;
  let totalCents = 0;
  let aiCents = 0;
  let automationsCents = 0;
  let otherCents = 0;
  let requestCount = 0;

  for (const item of interactions) {
    if (monthStart != null && new Date(item.createdAt).getTime() < monthStart) continue;
    const charge = item.customerChargeCents ?? 0;
    totalCents += charge;
    requestCount += 1;
    const category = usageClientCategory(item.clientKind);
    if (category === "ai") aiCents += charge;
    else if (category === "automations") automationsCents += charge;
    else otherCents += charge;
  }

  return { totalCents, aiCents, automationsCents, otherCents, requestCount };
}
