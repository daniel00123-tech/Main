import { Link } from "react-router-dom";
import { CheckCircle2, Circle } from "lucide-react";
import { deriveGettingStartedItems } from "@infra/shared";
import { SectionCard } from "../components";
import { usePortalCompany } from "./usePortalCompany";

export function PortalOnboardingChecklist() {
  const { company, overview, membership } = usePortalCompany();
  const canManage =
    membership?.role === "company_admin" || membership?.role === "director";

  if (!company || !overview || !canManage) return null;

  const incomplete = deriveGettingStartedItems({ overview });
  if (incomplete.length === 0) return null;

  return (
    <SectionCard title="Getting started" className="portal-getting-started">
      <p className="muted small portal-getting-started-intro">
        Finish these steps to get the most from INFRA.
      </p>
      <ul className="portal-getting-started-list">
        {incomplete.map((item) => (
          <li key={item.key}>
            <Link to={`/portal/${company.slug}/${item.path}`} className="portal-getting-started-link">
              <Circle size={16} className="muted" aria-hidden />
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
      {overview.onboarding?.readyForUse ? (
        <p className="muted small portal-getting-started-note">
          Optional setup — your company is already operational.
        </p>
      ) : null}
    </SectionCard>
  );
}

export function PortalGettingStartedSettingsLink() {
  const { company, overview, membership } = usePortalCompany();
  const canManage =
    membership?.role === "company_admin" || membership?.role === "director";
  if (!company || !overview || !canManage) return null;
  if (deriveGettingStartedItems({ overview }).length > 0) return null;

  return (
    <p className="muted small">
      <CheckCircle2 size={14} aria-hidden style={{ verticalAlign: "text-bottom" }} /> Setup complete.{" "}
      <Link to={`/portal/${company.slug}/settings`}>Company settings</Link>
    </p>
  );
}
