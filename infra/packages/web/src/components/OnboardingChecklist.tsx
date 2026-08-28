import { Link } from "react-router-dom";
import type { CompanyOnboarding } from "@infra/shared";
import { StatusBadge } from "../components";
import { applicabilityLabel, onboardingStatusPresentation } from "../lib/admin-present";

export function OnboardingChecklist({
  onboarding,
}: {
  onboarding: CompanyOnboarding;
}) {
  return (
    <div className="admin-onboarding-list">
      {onboarding.items.map((item) => {
        const { label, badgeStatus } = onboardingStatusPresentation(item.status);
        return (
          <article key={item.id} className="admin-onboarding-card">
            <div className="admin-onboarding-card-head">
              <div className="admin-onboarding-card-copy">
                <h4 className="admin-onboarding-card-title">{item.title}</h4>
                <p className="muted small admin-onboarding-card-summary">
                  {item.status === "complete"
                    ? item.detail.split(".")[0] ?? item.detail
                    : item.detail.length > 120
                      ? `${item.detail.slice(0, 117)}…`
                      : item.detail}
                </p>
              </div>
              <div className="admin-onboarding-card-badges">
                <span className="muted small admin-onboarding-applicability">
                  {applicabilityLabel(item.applicability)}
                </span>
                <StatusBadge status={badgeStatus} label={label} />
              </div>
            </div>
            {item.detail && item.status !== "complete" ? (
              <details className="admin-onboarding-technical">
                <summary>Technical details</summary>
                <p className="muted small">{item.detail}</p>
              </details>
            ) : null}
            {item.href ? (
              <div className="admin-onboarding-card-action">
                <Link to={item.href} className="button button-secondary button-small">
                  Open
                </Link>
              </div>
            ) : null}
          </article>
        );
      })}
      <p className="muted small admin-onboarding-footnote">
        {onboarding.readyForUse
          ? "Required foundation is in place. Optional connectors do not block readiness."
          : "Ready for use stays No until required items are complete. Optional systems such as Xero or ChatGPT do not block a company that does not need them."}
      </p>
    </div>
  );
}
