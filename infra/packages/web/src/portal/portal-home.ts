export function portalChatPath(companySlug: string, conversationId?: string | null): string {
  const base = `/portal/${encodeURIComponent(companySlug)}/chat`;
  if (!conversationId || conversationId === "draft") return base;
  return `${base}/${encodeURIComponent(conversationId)}`;
}

export function portalOverviewPath(companySlug: string): string {
  return `/portal/${encodeURIComponent(companySlug)}/dashboard`;
}

export function portalCompanyHomePath(companySlug: string): string {
  return portalChatPath(companySlug);
}

export function resolvePortalEntryTarget(input: {
  isPlatformAdmin: boolean;
  membershipCompanyIds: string[];
  companies: Array<{ id: string; slug: string }>;
}): string {
  if (input.isPlatformAdmin) return "/portal/select";
  const memberCompanies = input.companies.filter((company) =>
    input.membershipCompanyIds.includes(company.id),
  );
  if (memberCompanies.length > 1) return "/portal/select";
  const preferred = memberCompanies[0] ?? input.companies[0];
  if (!preferred) return "/portal/select";
  return portalChatPath(preferred.slug);
}

export function companyNavOrder(): string[] {
  return [
    "chat",
    "dashboard",
    "ai-connections",
    "automations",
    "actions",
    "connectors",
    "users",
    "usage",
    "billing",
    "activity",
    "settings",
  ];
}
