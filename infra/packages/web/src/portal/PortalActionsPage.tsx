import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardList } from "lucide-react";
import type { ActionPlanRecord } from "@infra/shared";
import { api } from "../api";
import {
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingState,
  PageHeader,
  SectionCard,
  StatusBadge,
} from "../components";
import { formatRelativeTime } from "../lib/format";
import { usePortalCompany } from "./usePortalCompany";

const PENDING_STATUSES = new Set([
  "awaiting_confirmation",
  "awaiting_approval",
  "validated",
  "approved",
  "executing",
]);

type DryRunReport = {
  readyToExecute?: boolean;
  headline?: string;
  organisation?: string | null;
  actionLabel?: string;
  type?: string | null;
  contact?: { id: string; name: string | null } | null;
  amount?: number | null;
  currencyCode?: string | null;
  reference?: string | null;
  description?: string | null;
  risk?: string;
  confirmation?: string;
  approval?: string;
  oauthWriteScope?: { status?: string; missing?: string[]; required?: string[] };
  executionGate?: { blocked?: boolean; reason?: string | null };
  preflightChecks?: Array<{ name: string; ok: boolean; detail?: string }>;
};

type ExecutionEvidence = {
  id?: string;
  status?: string;
  verificationStatus?: string | null;
  xeroResourceId?: string | null;
  humanReference?: string | null;
  amount?: number | null;
  currencyCode?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

function humanAction(action: string): string {
  return action.replace(/^xero\./, "Xero · ").replace(/\./g, " · ");
}

export default function PortalActionsPage() {
  const { company, loading, error } = usePortalCompany();
  const [plans, setPlans] = useState<ActionPlanRecord[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [dryRun, setDryRun] = useState<DryRunReport | null>(null);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [execution, setExecution] = useState<ExecutionEvidence | null>(null);
  const [executionLoading, setExecutionLoading] = useState(false);

  const loadPlans = useCallback(async () => {
    if (!company) return;
    setPlansLoading(true);
    setPlansError(null);
    try {
      const response = await api.listCompanyActions(company.slug);
      setPlans(response.plans);
    } catch (err) {
      setPlansError(err instanceof Error ? err.message : "Unable to load actions");
    } finally {
      setPlansLoading(false);
    }
  }, [company]);

  useEffect(() => {
    void loadPlans();
  }, [loadPlans]);

  const filtered = useMemo(() => {
    if (filter === "all") return plans;
    return plans.filter((plan) => PENDING_STATUSES.has(plan.status));
  }, [plans, filter]);

  const selected = filtered.find((plan) => plan.id === selectedId) ?? filtered[0] ?? null;

  useEffect(() => {
    if (!company || !selected) {
      setDryRun(null);
      setExecution(null);
      return;
    }

    let cancelled = false;
    setDryRunLoading(true);
    setExecutionLoading(true);
    setDryRun(null);
    setExecution(null);

    void api
      .getCompanyActionDryRun(company.slug, selected.id)
      .then((response) => {
        if (!cancelled) setDryRun(response.report as DryRunReport);
      })
      .catch(() => {
        if (!cancelled) setDryRun(null);
      })
      .finally(() => {
        if (!cancelled) setDryRunLoading(false);
      });

    void api
      .getCompanyActionExecution(company.slug, selected.id)
      .then((response) => {
        if (!cancelled) setExecution((response.execution as ExecutionEvidence) ?? null);
      })
      .catch(() => {
        if (!cancelled) setExecution(null);
      })
      .finally(() => {
        if (!cancelled) setExecutionLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [company, selected?.id]);

  if (loading) return <LoadingState />;
  if (error || !company) {
    return <ErrorState title="Unable to load actions" description={error ?? undefined} />;
  }

  return (
    <>
      <PageHeader
        title="Actions"
        description={`${company.name} · planned financial actions and approvals`}
      />

      <SectionCard
        title="Action plans"
        description="Server-side execution plans created by AI requests. Financial writes remain disabled until operator approval."
        actions={
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className={`button button-small ${filter === "pending" ? "button-primary" : "button-secondary"}`}
              onClick={() => setFilter("pending")}
            >
              Pending
            </button>
            <button
              type="button"
              className={`button button-small ${filter === "all" ? "button-primary" : "button-secondary"}`}
              onClick={() => setFilter("all")}
            >
              All
            </button>
          </div>
        }
      >
        {plansLoading ? (
          <LoadingState label="Loading action plans…" />
        ) : plansError ? (
          <ErrorState title="Unable to load plans" description={plansError} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<ClipboardList size={28} />}
            title="No action plans"
            description="When ChatGPT plans a financial action (credit invoice, draft invoice, payment allocation), it appears here for review."
          />
        ) : (
          <div className="split-panel">
            <div className="split-panel-list">
              {filtered.map((plan) => (
                <button
                  key={plan.id}
                  type="button"
                  className={`list-row ${selected?.id === plan.id ? "active" : ""}`}
                  onClick={() => setSelectedId(plan.id)}
                >
                  <div style={{ fontWeight: 600 }}>{plan.summary ?? humanAction(plan.requestedAction)}</div>
                  <div className="muted small">
                    {humanAction(plan.requestedAction)} · {formatRelativeTime(plan.createdAt)}
                  </div>
                  <StatusBadge status={plan.status} label={plan.status.replace(/_/g, " ")} />
                </button>
              ))}
            </div>

            {selected ? (
              <div className="split-panel-detail">
                <h3 style={{ marginTop: 0 }}>{selected.summary ?? selected.id}</h3>
                <KeyValue label="Plan ID" value={selected.id} />
                <KeyValue label="Action" value={humanAction(selected.requestedAction)} />
                <KeyValue label="Status" value={selected.status} />
                <KeyValue label="Requested by" value={selected.actor} />
                <KeyValue label="Source" value={selected.sourceClient ?? "—"} />
                <KeyValue label="Confirmation" value={selected.confirmationStatus} />
                <KeyValue label="Approval" value={selected.approvalStatus} />
                <KeyValue label="Risk" value={selected.riskClass.replace(/_/g, " ")} />
                {selected.financialImpact ? (
                  <KeyValue
                    label="Amount"
                    value={`${selected.financialImpact.totalAmount ?? "—"} ${selected.financialImpact.currencyCode ?? ""}`.trim()}
                  />
                ) : null}
                {selected.expiresAt ? (
                  <KeyValue label="Expires" value={formatRelativeTime(selected.expiresAt)} />
                ) : null}

                <h4>Execution readiness</h4>
                {dryRunLoading ? (
                  <p className="muted small">Checking live readiness…</p>
                ) : dryRun ? (
                  <>
                    <KeyValue label="Readiness" value={dryRun.headline ?? "—"} />
                    <KeyValue label="Xero organisation" value={dryRun.organisation ?? "—"} />
                    <KeyValue label="Action type" value={dryRun.type ?? "—"} />
                    {dryRun.contact ? (
                      <KeyValue
                        label="Contact"
                        value={`${dryRun.contact.name ?? "Unknown"} (${dryRun.contact.id})`}
                      />
                    ) : null}
                    {dryRun.reference ? <KeyValue label="Reference" value={dryRun.reference} /> : null}
                    {dryRun.description ? <KeyValue label="Description" value={dryRun.description} /> : null}
                    <KeyValue
                      label="OAuth write scope"
                      value={
                        dryRun.oauthWriteScope?.status === "ready"
                          ? "Ready"
                          : `Missing: ${(dryRun.oauthWriteScope?.missing ?? []).join(", ") || "accounting.invoices"}`
                      }
                    />
                    <KeyValue
                      label="Execution gate"
                      value={
                        dryRun.executionGate?.blocked
                          ? dryRun.executionGate.reason ?? "Blocked"
                          : "Open"
                      }
                    />
                    <KeyValue label="Confirmation required" value={dryRun.confirmation ?? "—"} />
                    <KeyValue label="Approval required" value={dryRun.approval ?? "—"} />
                    {dryRun.preflightChecks?.length ? (
                      <>
                        <h5>Preflight checks</h5>
                        <ul className="plain-list">
                          {dryRun.preflightChecks.map((check) => (
                            <li key={check.name}>
                              <strong>{check.name}</strong> — {check.ok ? "OK" : "FAIL"}
                              {check.detail ? <span className="muted small"> · {check.detail}</span> : null}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </>
                ) : (
                  <p className="muted small">Dry-run unavailable for this plan.</p>
                )}

                <h4>Targets ({selected.targets.length})</h4>
                <ul className="plain-list">
                  {selected.targets.map((target) => (
                    <li key={`${target.targetType}-${target.targetId}`}>
                      <strong>{target.humanRef}</strong> — {target.validation}
                      {target.amount != null ? ` · ${target.amount}` : ""}
                      {target.validationDetail ? (
                        <div className="muted small">{target.validationDetail}</div>
                      ) : null}
                    </li>
                  ))}
                </ul>

                {selected.permissionDecision ? (
                  <>
                    <h4>Permission</h4>
                    <KeyValue label="Decision" value={selected.permissionDecision.reasonCode} />
                    <KeyValue
                      label="Writes enabled"
                      value={selected.permissionDecision.financialWritesEnabled ? "Yes" : "No"}
                    />
                  </>
                ) : null}

                <h4>Execution evidence</h4>
                {executionLoading ? (
                  <p className="muted small">Loading execution record…</p>
                ) : execution?.id ? (
                  <>
                    <KeyValue label="Execution ID" value={execution.id} />
                    <KeyValue label="Execution status" value={execution.status ?? "—"} />
                    <KeyValue label="Verification" value={execution.verificationStatus ?? "—"} />
                    {execution.xeroResourceId ? (
                      <KeyValue label="Xero record ID" value={execution.xeroResourceId} />
                    ) : null}
                    {execution.humanReference ? (
                      <KeyValue label="Xero reference" value={execution.humanReference} />
                    ) : null}
                    {execution.amount != null ? (
                      <KeyValue
                        label="Result amount"
                        value={`${execution.amount} ${execution.currencyCode ?? ""}`.trim()}
                      />
                    ) : null}
                    {execution.errorCode ? (
                      <KeyValue label="Error" value={`${execution.errorCode}: ${execution.errorMessage ?? ""}`} />
                    ) : null}
                  </>
                ) : (
                  <p className="muted small">No execution attempted yet.</p>
                )}
              </div>
            ) : null}
          </div>
        )}
      </SectionCard>
    </>
  );
}
