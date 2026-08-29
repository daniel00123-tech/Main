/** Tenant display helpers — never hard-code a company name or logo. */

export function companyDisplayName(company: {
  name: string;
  tradingName?: string | null;
}): string {
  const trading = company.tradingName?.trim();
  return trading || company.name.trim() || "Company";
}

export function companyInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean);
  if (parts.length === 0) return "CO";
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
}

export function companyLogoUrl(company: {
  logoUrl?: string | null;
  branding?: Record<string, unknown> | null;
}): string | null {
  const direct = company.logoUrl?.trim();
  if (direct) return direct;
  const fromBranding = company.branding?.logoUrl;
  return typeof fromBranding === "string" && fromBranding.trim()
    ? fromBranding.trim()
    : null;
}
