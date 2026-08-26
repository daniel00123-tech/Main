import { Link } from "react-router-dom";
import type { CompanyOnboarding } from "@infra/shared";
import { StatusBadge } from "../components";

export function OnboardingChecklist({
  onboarding,
}: {
  onboarding: CompanyOnboarding;
}) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      {onboarding.items.map((item) => (
        <div key={item.id} className="connection-header" style={{ marginBottom: 0 }}>
          <div>
            <strong>{item.title}</strong>
            <div className="muted small">{item.detail}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {item.applicability === "optional" ? (
              <span className="muted small">Optional</span>
            ) : item.applicability === "not_applicable" ? (
              <span className="muted small">Not required</span>
            ) : (
              <span className="muted small">Required</span>
            )}
            <StatusBadge status={item.status} />
            {item.href ? (
              <Link to={item.href} className="button button-ghost button-small">
                Open
              </Link>
            ) : null}
          </div>
        </div>
      ))}
      <p className="muted small" style={{ margin: 0 }}>
        {onboarding.readyForUse
          ? "Required foundation is in place. Optional connectors do not block readiness."
          : "Ready for use stays No until required items are complete. Optional systems such as Xero or ChatGPT do not block a company that does not need them."}
      </p>
    </div>
  );
}
