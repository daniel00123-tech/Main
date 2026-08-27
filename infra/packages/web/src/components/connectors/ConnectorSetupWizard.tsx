import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ConnectorDefinition, ConnectorWizardState } from "@infra/shared";
import { LoadingState, Notice, StatusBadge } from "../../components";
import { api } from "../../api";

function stepTone(status: string): string {
  switch (status) {
    case "completed":
      return "healthy";
    case "blocked":
      return "failed";
    case "attention_required":
      return "warning";
    case "available":
      return "connected";
    default:
      return "not_configured";
  }
}

export function ConnectorSetupWizard({
  connector,
  companySlug,
  onAction,
}: {
  connector: ConnectorDefinition;
  companySlug: string;
  onAction?: () => void;
}) {
  const [wizard, setWizard] = useState<ConnectorWizardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await api.getConnectorWizard(companySlug, connector.id);
        setWizard(response.wizard);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load setup wizard");
      } finally {
        setLoading(false);
      }
    })();
  }, [companySlug, connector.id]);

  async function handleStepAction(stepId: string) {
    if (!wizard) return;
    const step = wizard.steps.find((s) => s.id === stepId);
    if (!step?.actionKind || step.actionKind === "none") return;

    if (step.actionKind === "navigate" && step.actionTarget) {
      window.location.href = step.actionTarget;
      return;
    }

    if (step.actionKind === "oauth" && connector.id === "conn_xero") {
      setBusy(true);
      try {
        const started = await api.startConnectorOAuth(companySlug, connector.id);
        window.location.href = started.authorizationUrl;
      } catch (err) {
        setError(err instanceof Error ? err.message : "OAuth start failed");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (step.actionKind === "test" && wizard.instanceId) {
      setBusy(true);
      try {
        await api.testConnectorConnection(companySlug, wizard.instanceId);
        onAction?.();
        const response = await api.getConnectorWizard(companySlug, connector.id);
        setWizard(response.wizard);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Test failed");
      } finally {
        setBusy(false);
      }
    }
  }

  if (loading) return <LoadingState label="Loading setup steps…" />;
  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!wizard) return null;

  return (
    <div className="stack" style={{ gap: 12 }}>
      {wizard.presentation ? (
        <div className="muted small">
          Status:{" "}
          <StatusBadge status={wizard.presentation.authStatus} label={wizard.presentation.label} />
        </div>
      ) : null}

      {wizard.blockers
        .filter((b) => b.severity !== "info")
        .map((blocker) => (
          <Notice key={blocker.code} tone={blocker.severity === "blocking" ? "warning" : "info"}>
            {blocker.message}
            {blocker.remediation ? ` — ${blocker.remediation}` : ""}
          </Notice>
        ))}

      <ol className="wizard-steps">
        {wizard.steps.map((step) => (
          <li key={step.id} className={`wizard-step wizard-step--${step.status}`}>
            <div className="wizard-step-head">
              <strong>{step.title}</strong>
              <StatusBadge status={stepTone(step.status)} label={step.status.replace(/_/g, " ")} />
            </div>
            <p className="muted small" style={{ margin: "4px 0" }}>
              {step.description}
            </p>
            {step.detail ? <p className="muted small">{step.detail}</p> : null}
            {step.actionLabel && step.status === "available" ? (
              step.actionKind === "navigate" && step.actionTarget ? (
                <Link to={step.actionTarget.replace(/^https?:\/\/[^/]+/, "")} className="button button-secondary">
                  {step.actionLabel}
                </Link>
              ) : (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => void handleStepAction(step.id)}
                >
                  {step.actionLabel}
                </button>
              )
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
