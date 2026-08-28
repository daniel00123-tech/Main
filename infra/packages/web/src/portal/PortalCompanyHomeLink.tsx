import { Link } from "react-router-dom";

export function portalOverviewPath(companySlug: string): string {
  return `/portal/${encodeURIComponent(companySlug)}/dashboard`;
}

export function PortalCompanyHomeLink({
  company,
  className,
}: {
  company: { slug: string; name: string };
  className?: string;
}) {
  return (
    <Link
      to={portalOverviewPath(company.slug)}
      className={["portal-company-home-link", className].filter(Boolean).join(" ")}
      aria-label={`Go to ${company.name} overview`}
      title={`Go to ${company.name} overview`}
    >
      {company.name}
    </Link>
  );
}
