import { useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Circle } from "lucide-react";
import {
  deriveGettingStartedItems,
  gettingStartedProgress,
  isGettingStartedDismissed,
} from "@infra/shared";
import { SectionCard } from "../components";
import { api } from "../api";
import { usePortalCompany } from "./usePortalCompany";

export function PortalOnboardingChecklist() {
  const { company, overview, membership, refresh } = usePortalCompany();
  const [dismissing, setDismissing] = useState(false);
  const [dismissedLocally, setDismissedLocally] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);

  const canManage =
    membership?.role === "company_admin" || membership?.role === "director";

  if (!company || !overview || !canManage) return null;
  if (dismissedLocally || isGettingStartedDismissed(overview)) return null;

  const items = deriveGettingStartedItems({ overview });
  const progress = gettingStartedProgress(items);

  async function dismissChecklist() {
    if (!company || dismissing) return;
    setDismissing(true);
    setDismissError(null);
    setDismissedLocally(true);
    try {
      await api.updateCompanySettings(company.slug, { gettingStartedDismissed: true });
      await refresh();
    } catch (err) {
      setDismissedLocally(false);
      setDismissError(err instanceof Error ? err.message : "Unable to dismiss checklist");
    } finally {
      setDismissing(false);
    }
  }

  const dismissControl = (
    <button
      type="button"
      className="button button-ghost button-small"
      onClick={() => void dismissChecklist()}
      disabled={dismissing}
    >
      Dismiss checklist
    </button>
  );

  if (progress.allComplete) {
    return (
      <SectionCard
        title="Getting started"
        description="You're all set"
        className="portal-getting-started portal-getting-started-complete"
        actions={dismissControl}
      >
        <p className="muted small portal-getting-started-progress">
          {progress.completedCount} of {progress.totalCount} completed
        </p>
        {dismissError ? <p className="error-text small">{dismissError}</p> : null}
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Getting started"
      description={`${progress.completedCount} of ${progress.totalCount} completed`}
      className="portal-getting-started"
      actions={dismissControl}
    >
      <p className="muted small portal-getting-started-intro">
        Finish these steps to get the most from INFRA.
      </p>
      <ul className="portal-getting-started-list">
        {items.map((item) => {
          const content = (
            <>
              {item.complete ? (
                <CheckCircle2 size={16} className="portal-getting-started-check" aria-hidden />
              ) : (
                <Circle size={16} className="muted" aria-hidden />
              )}
              {item.label}
            </>
          );
          return (
            <li
              key={item.key}
              className={
                item.complete
                  ? "portal-getting-started-item is-complete"
                  : "portal-getting-started-item"
              }
            >
              {item.complete ? (
                <span className="portal-getting-started-done">{content}</span>
              ) : (
                <Link
                  to={`/portal/${company.slug}/${item.path}`}
                  className="portal-getting-started-link"
                >
                  {content}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {overview.onboarding?.readyForUse ? (
        <p className="muted small portal-getting-started-note">
          Optional setup — your company is already operational.
        </p>
      ) : null}
      {dismissError ? <p className="error-text small">{dismissError}</p> : null}
    </SectionCard>
  );
}

export function PortalGettingStartedSettingsLink() {
  const { company, overview, membership } = usePortalCompany();
  const canManage =
    membership?.role === "company_admin" || membership?.role === "director";
  if (!company || !overview || !canManage) return null;
  if (!gettingStartedProgress(deriveGettingStartedItems({ overview })).allComplete) {
    return null;
  }

  return (
    <p className="muted small">
      <CheckCircle2 size={14} aria-hidden style={{ verticalAlign: "text-bottom" }} /> Setup complete.{" "}
      <Link to={`/portal/${company.slug}/settings`}>Company settings</Link>
    </p>
  );
}
