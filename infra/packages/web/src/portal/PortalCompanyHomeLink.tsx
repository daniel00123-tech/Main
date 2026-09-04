import { Link } from "react-router-dom";
import { portalCompanyHomePath, portalOverviewPath } from "./portal-home";

export { portalCompanyHomePath, portalOverviewPath };

export function PortalCompanyHomeLink({
  company,
  className,
}: {
  company: { slug: string; name: string };
  className?: string;
}) {
  return (
    <Link
      to={portalCompanyHomePath(company.slug)}
      className={["portal-company-home-link", className].filter(Boolean).join(" ")}
      aria-label={`Go to ${company.name} chat`}
      title={`Go to ${company.name} chat`}
    >
      {company.name}
    </Link>
  );
}
