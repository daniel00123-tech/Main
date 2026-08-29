import { companyDisplayName, companyInitials, companyLogoUrl } from "@infra/shared";
import type { Company } from "@infra/shared";

type BrandCompany = Pick<Company, "name" | "tradingName" | "logoUrl" | "branding">;

export function PortalCompanyAvatar({
  company,
  size = 32,
}: {
  company: BrandCompany;
  size?: number;
}) {
  const name = companyDisplayName(company);
  const logo = companyLogoUrl(company);
  const initials = companyInitials(name);

  if (logo) {
    return (
      <span className="company-avatar" style={{ width: size, height: size }}>
        <img
          src={logo}
          alt=""
          width={size}
          height={size}
          onError={(event) => {
            event.currentTarget.style.display = "none";
            const fallback = event.currentTarget.nextElementSibling;
            if (fallback instanceof HTMLElement) fallback.hidden = false;
          }}
        />
        <span className="company-avatar-fallback" hidden aria-hidden>
          {initials}
        </span>
      </span>
    );
  }

  return (
    <span className="company-avatar company-avatar-fallback" style={{ width: size, height: size }} aria-hidden>
      {initials}
    </span>
  );
}

export function PortalCompanyBrand({
  company,
  showInfra = true,
  compact = false,
}: {
  company: BrandCompany;
  showInfra?: boolean;
  compact?: boolean;
}) {
  const name = companyDisplayName(company);
  return (
    <span className={`company-brand${compact ? " company-brand--compact" : ""}`}>
      <PortalCompanyAvatar company={company} size={compact ? 28 : 32} />
      <span className="company-brand-text">
        <span className="company-brand-name">{name}</span>
        {showInfra ? <span className="company-brand-infra">INFRA</span> : null}
      </span>
    </span>
  );
}
