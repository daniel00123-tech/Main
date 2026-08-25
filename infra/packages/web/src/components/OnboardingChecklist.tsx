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
          ? "This company has the INFRA foundation needed for day-to-day use."
          : "Ready for use stays No until a Business MCP and an AI connection both exist. Creating a company does not provision a Worker."}
      </p>
    </div>
  );
}
