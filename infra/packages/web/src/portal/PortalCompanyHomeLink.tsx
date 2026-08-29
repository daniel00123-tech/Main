import { Link } from "react-router-dom";
import type { Company } from "@infra/shared";
import { companyDisplayName } from "@infra/shared";
import { PortalCompanyBrand } from "./PortalCompanyBrand";

export function portalOverviewPath(companySlug: string): string {
  return `/portal/${encodeURIComponent(companySlug)}/dashboard`;
}

export function PortalCompanyHomeLink({
  company,
  className,
  compact = false,
}: {
  company: Pick<Company, "slug" | "name" | "tradingName" | "logoUrl" | "branding">;
  className?: string;
  compact?: boolean;
}) {
  const name = companyDisplayName(company);
  return (
    <Link
      to={portalOverviewPath(company.slug)}
      className={["portal-company-home-link", className].filter(Boolean).join(" ")}
      aria-label={`Go to ${name} overview`}
      title={`Go to ${name} overview`}
    >
      <PortalCompanyBrand company={company} compact={compact} />
    </Link>
  );
}
