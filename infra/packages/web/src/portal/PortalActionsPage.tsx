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
                {selected.financialImpact ? (
                  <KeyValue
                    label="Financial impact"
                    value={`${selected.financialImpact.totalAmount ?? "—"} ${selected.financialImpact.currencyCode ?? ""}`.trim()}
                  />
                ) : null}
                {selected.expiresAt ? (
                  <KeyValue label="Expires" value={formatRelativeTime(selected.expiresAt)} />
                ) : null}

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
              </div>
            ) : null}
          </div>
        )}
      </SectionCard>
    </>
  );
}
