import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardList } from "lucide-react";
import type { ActionPlanRecord } from "@infra/shared";
import { api } from "../api";
import {
  AdvancedDetails,
  Button,
  ConfirmDangerModal,
  Drawer,
  EmptyState,
  ErrorState,
  FilterBar,
  KeyValue,
  LoadingState,
  MobileRecordCard,
  MobileRecordList,
  Notice,
  SearchInput,
  SectionCard,
  ShowMoreFooter,
  StatusBadge,
  toast,
  useIsMobile,
} from "../components";
import {
  actionCentreBucket,
  formatActionAmount,
  formatRelativeTime,
  humanActionStatus,
  humanActor,
  humanApprovalStatus,
  humanClient,
  humanConfirmationStatus,
  humanOperation,
  humanRiskClass,
  planFailureDisplayReason,
  planIsApprovable,
  planIsConfirmable,
  type ActionCentreBucket,
} from "../lib/format";
import { PortalPageBody, PortalPageHeader, SegmentedControl } from "./components";
import { usePortalCompany } from "./usePortalCompany";
import { filterCustomerActions } from "../lib/customer-visibility";

type DryRunReport = {
  readyToExecute?: boolean;
  headline?: string;
  organisation?: string | null;
  contact?: { id: string; name: string | null } | null;
  amount?: number | null;
  currencyCode?: string | null;
  reference?: string | null;
  description?: string | null;
};

type ExecutionEvidence = {
  id?: string;
  status?: string;
  xeroResourceId?: string | null;
  humanReference?: string | null;
  errorMessage?: string | null;
};

function planTitle(plan: ActionPlanRecord): string {
  if (plan.summary) return plan.summary;
  const amount = plan.financialImpact?.totalAmount;
  const currency = plan.financialImpact?.currencyCode ?? "GBP";
  const contact = plan.targets[0]?.humanRef;
  if (amount != null && contact) {
    return `${humanOperation(plan.requestedAction)} for ${contact} — ${formatActionAmount(amount, currency)}`;
  }
  return humanOperation(plan.requestedAction);
}

function actionBucketTitle(bucket: ActionCentreBucket): string {
  switch (bucket) {
    case "needs_approval":
      return "Waiting for your approval";
    case "in_progress":
      return "In progress";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
  }
}

function planCustomerLabel(plan: ActionPlanRecord): string | null {
  return plan.targets[0]?.humanRef ?? null;
}

function planWhatWillHappen(plan: ActionPlanRecord): string {
  if (plan.summary) return plan.summary;
  return humanOperation(plan.requestedAction);
}

function systemLabel(plan: ActionPlanRecord): string {
  if (plan.provider === "xero") return "Xero";
  return plan.provider ?? "INFRA";
}

export default function PortalActionsPage() {
  const { company, loading, error, membership, user } = usePortalCompany();
  const [plans, setPlans] = useState<ActionPlanRecord[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<ActionCentreBucket>("needs_approval");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<DryRunReport | null>(null);
  const [execution, setExecution] = useState<ExecutionEvidence | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [displayLimit, setDisplayLimit] = useState(20);
  const isMobile = useIsMobile();

  const canApprove =
    user?.isPlatformAdmin ||
    membership?.role === "company_admin" ||
    membership?.role === "director";

  const loadPlans = useCallback(async () => {
    if (!company) return;
    setPlansLoading(true);
    setPlansError(null);
    try {
      const response = await api.listCompanyActions(company.slug);
      setPlans(filterCustomerActions(response.plans, Boolean(user?.isPlatformAdmin)));
    } catch (err) {
      setPlansError(err instanceof Error ? err.message : "Unable to load actions");
    } finally {
      setPlansLoading(false);
    }
  }, [company, user?.isPlatformAdmin]);

  useEffect(() => {
    void loadPlans();
  }, [loadPlans]);

  const bucketCounts = useMemo(() => {
    const counts: Record<ActionCentreBucket, number> = {
      needs_approval: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
    };
    for (const plan of plans) {
      counts[actionCentreBucket(plan.status)] += 1;
    }
    return counts;
  }, [plans]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plans.filter((plan) => {
      if (actionCentreBucket(plan.status) !== bucket) return false;
      if (!q) return true;
      return (
        planTitle(plan).toLowerCase().includes(q) ||
        humanActor(plan.actor).toLowerCase().includes(q) ||
        systemLabel(plan).toLowerCase().includes(q)
      );
    });
  }, [plans, bucket, query]);

  const visible = filtered.slice(0, displayLimit);
  const selected = plans.find((plan) => plan.id === selectedId) ?? visible[0] ?? null;

  useEffect(() => {
    setDisplayLimit(20);
  }, [bucket, query]);

  useEffect(() => {
    if (!company || !selected) {
      setDryRun(null);
      setExecution(null);
      return;
    }
    let cancelled = false;
    void api
      .getCompanyActionDryRun(company.slug, selected.id)
      .then((response) => {
        if (!cancelled) setDryRun(response.report as DryRunReport);
      })
      .catch(() => {
        if (!cancelled) setDryRun(null);
      });
    void api
      .getCompanyActionExecution(company.slug, selected.id)
      .then((response) => {
        if (!cancelled) setExecution((response.execution as ExecutionEvidence) ?? null);
      })
      .catch(() => {
        if (!cancelled) setExecution(null);
      });
    return () => {
      cancelled = true;
    };
  }, [company, selected?.id]);

  async function approve(plan: ActionPlanRecord) {
    if (!company) return;
    setBusy("approve");
    try {
      await api.approveCompanyAction(company.slug, plan.id);
      toast("Action approved");
      await loadPlans();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Approval failed", "error");
    } finally {
      setBusy(null);
    }
  }

  async function confirm(plan: ActionPlanRecord) {
    if (!company) return;
    setBusy("confirm");
    try {
      await api.confirmCompanyAction(company.slug, plan.id);
      toast("Action confirmed");
      await loadPlans();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Confirmation failed", "error");
    } finally {
      setBusy(null);
    }
  }

  async function reject(plan: ActionPlanRecord) {
    if (!company) return;
    setBusy("reject");
    try {
      await api.rejectCompanyAction(company.slug, plan.id);
      toast("Action rejected");
      setRejectOpen(false);
      setSelectedId(null);
      await loadPlans();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Rejection failed", "error");
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <LoadingState />;
  if (error || !company) {
    return <ErrorState title="Unable to load actions" description={error ?? undefined} />;
  }

  const detailPanel = selected ? (
    <>
      <h3 style={{ marginTop: 0 }}>{planTitle(selected)}</h3>
      <KeyValue label="Status" value={<StatusBadge status={selected.status} label={humanActionStatus(selected.status)} />} />
      <KeyValue label="Requested by" value={humanActor(selected.actor)} />
      <KeyValue label="When" value={formatRelativeTime(selected.createdAt)} />

      <SectionCard title="What will happen">
        <p style={{ margin: 0 }}>{planWhatWillHappen(selected)}</p>
        {dryRun?.headline ? (
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            {dryRun.headline}
          </p>
        ) : null}
      </SectionCard>

      <SectionCard title="Why approval is required">
        <p style={{ margin: 0 }}>
          {selected.riskClass === "delete" || selected.requestedAction.includes("void")
            ? "This changes or voids an accounting record and cannot be undone from Infra."
            : selected.requestedAction.includes("payment")
              ? "This records a payment in Xero and should be checked before it is posted."
              : "Infra is waiting for approval before it continues this accounting change."}
        </p>
      </SectionCard>

      <SectionCard title="Financial impact">
        {selected.financialImpact?.totalAmount != null ? (
          <p style={{ margin: 0 }}>
            {formatActionAmount(
              selected.financialImpact.totalAmount,
              selected.financialImpact.currencyCode ?? "GBP",
            )}
            {planCustomerLabel(selected) ? ` · ${planCustomerLabel(selected)}` : ""}
          </p>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            No amount is attached to this request.
          </p>
        )}
        {(selected.targets[0]?.proposedState as { warning?: string })?.warning ? (
          <Notice tone="warning">
            {String((selected.targets[0]?.proposedState as { warning?: string }).warning)}
          </Notice>
        ) : null}
      </SectionCard>

      {execution?.errorMessage || planFailureDisplayReason(selected) ? (
        <Notice tone="danger">
          {planFailureDisplayReason(selected) ?? execution?.errorMessage}
        </Notice>
      ) : null}

      <div className="action-detail-actions">
        {planIsConfirmable(selected) && canApprove ? (
          <Button type="button" variant="primary" loading={busy === "confirm"} onClick={() => void confirm(selected)}>
            Confirm
          </Button>
        ) : null}
        {planIsApprovable(selected) && canApprove ? (
          <>
            <Button type="button" variant="primary" loading={busy === "approve"} onClick={() => void approve(selected)}>
              {selected.riskClass === "delete" || selected.requestedAction.includes("void")
                ? "Approve void"
                : selected.requestedAction.includes("payment")
                  ? `Approve payment${selected.financialImpact?.totalAmount != null ? ` (${formatActionAmount(selected.financialImpact.totalAmount, selected.financialImpact.currencyCode ?? "GBP")})` : ""}`
                  : "Approve"}
            </Button>
            <Button type="button" variant="danger" onClick={() => setRejectOpen(true)}>
              Reject
            </Button>
          </>
        ) : null}
        <Button type="button" variant="ghost" onClick={() => setSelectedId(null)}>
          Back
        </Button>
        {selected.actor === user?.email && selected.status === "awaiting_approval" ? (
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            You cannot approve your own request — another director or admin must approve.
          </p>
        ) : null}
      </div>

      <AdvancedDetails label="Technical details">
        <KeyValue label="System" value={systemLabel(selected)} />
        <KeyValue label="Requested from" value={humanClient(selected.sourceClient)} />
        <KeyValue label="Confirmation" value={humanConfirmationStatus(selected.confirmationStatus)} />
        <KeyValue label="Approval" value={humanApprovalStatus(selected.approvalStatus)} />
        <KeyValue label="Risk class" value={humanRiskClass(selected.riskClass)} />
        {dryRun?.organisation ? <KeyValue label="Organisation" value={dryRun.organisation} /> : null}
        {execution?.humanReference ? <KeyValue label="Result reference" value={execution.humanReference} /> : null}
        {selected.targets[0]?.proposedState?.documentKind ? (
          <KeyValue label="Document type" value={String(selected.targets[0].proposedState.documentKind)} />
        ) : null}
        {selected.targets[0]?.currentState?.status != null ? (
          <KeyValue label="Current state" value={String(selected.targets[0].currentState.status)} />
        ) : null}
        {selected.targets[0]?.proposedState?.resultingStatus != null ? (
          <KeyValue label="Resulting state" value={String(selected.targets[0].proposedState.resultingStatus)} />
        ) : null}
        <KeyValue label="Plan ID" value={selected.id} mono />
        <KeyValue label="Action code" value={selected.requestedAction} mono />
        {execution?.id ? <KeyValue label="Execution ID" value={execution.id} mono /> : null}
        {execution?.xeroResourceId ? <KeyValue label="Xero resource" value={execution.xeroResourceId} mono /> : null}
        {selected.expiresAt ? <KeyValue label="Expires" value={formatRelativeTime(selected.expiresAt)} /> : null}
      </AdvancedDetails>
    </>
  ) : null;

  return (
    <div className="portal-page">
      <PortalPageHeader
        title="Approvals"
        description="Review planned accounting actions before they run."
      />

      <FilterBar>
        <SearchInput value={query} onChange={setQuery} placeholder="Search actions…" className="filter-grow" />
      </FilterBar>

      <SegmentedControl
        value={bucket}
        onChange={setBucket}
        options={[
          { id: "needs_approval", label: "Waiting for approval", count: bucketCounts.needs_approval },
          { id: "in_progress", label: "In progress", count: bucketCounts.in_progress },
          { id: "completed", label: "Completed", count: bucketCounts.completed },
          { id: "failed", label: "Failed", count: bucketCounts.failed },
        ]}
      />

      <PortalPageBody
        loading={plansLoading}
        error={plansError}
        loadingLabel="Loading approvals…"
        errorTitle="We couldn't load your approvals"
        onRetry={() => void loadPlans()}
      >
      <SectionCard title={actionBucketTitle(bucket)}>
        {filtered.length === 0 ? (
          <EmptyState
            icon={<ClipboardList size={28} />}
            title={
              bucket === "needs_approval"
                ? "No actions need your approval"
                : bucket === "completed"
                  ? "No completed actions yet"
                  : bucket === "failed"
                    ? "No failed actions"
                    : "Nothing in progress"
            }
            description={
              bucket === "needs_approval"
                ? "You're all caught up."
                : "When a financial action is planned, it appears here for review."
            }
          />
        ) : isMobile ? (
          <>
            <MobileRecordList>
              {visible.map((plan) => (
                <MobileRecordCard key={plan.id} onClick={() => setSelectedId(plan.id)}>
                  <div className="mobile-record-header">
                    <div className="mobile-record-title">{humanOperation(plan.requestedAction)}</div>
                    <StatusBadge status={plan.status} label={humanActionStatus(plan.status)} />
                  </div>
                  <dl className="mobile-record-meta">
                    {planCustomerLabel(plan) ? (
                      <div>
                        <dt>Customer</dt>
                        <dd>{planCustomerLabel(plan)}</dd>
                      </div>
                    ) : null}
                    {plan.financialImpact?.totalAmount != null ? (
                      <div>
                        <dt>Amount</dt>
                        <dd>
                          {formatActionAmount(
                            plan.financialImpact.totalAmount,
                            plan.financialImpact.currencyCode ?? "GBP",
                          )}
                        </dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>What will happen</dt>
                      <dd>{planWhatWillHappen(plan)}</dd>
                    </div>
                  </dl>
                </MobileRecordCard>
              ))}
            </MobileRecordList>
            <ShowMoreFooter
              shown={visible.length}
              total={filtered.length}
              onShowMore={() => setDisplayLimit((n) => n + 20)}
            />
            <Drawer
              open={Boolean(selected)}
              onClose={() => setSelectedId(null)}
              title="Action details"
            >
              {detailPanel}
            </Drawer>
          </>
        ) : (
          <div className="grid grid-2" style={{ gap: 0, alignItems: "start" }}>
            <CompactActionList
              plans={visible}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
            />
            <div className="card" style={{ padding: "var(--s-4)" }}>
              {detailPanel ?? <p className="muted">Select an action to view details.</p>}
            </div>
          </div>
        )}
      </SectionCard>

      {!isMobile && filtered.length > visible.length ? (
        <ShowMoreFooter
          shown={visible.length}
          total={filtered.length}
          onShowMore={() => setDisplayLimit((n) => n + 20)}
        />
      ) : null}
      </PortalPageBody>

      <ConfirmDangerModal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onConfirm={() => selected && void reject(selected)}
        title="Reject this action?"
        description="The action will be marked rejected and will not be executed."
        confirmLabel="Reject action"
        loading={busy === "reject"}
      />
    </div>
  );
}

function CompactActionList({
  plans,
  selectedId,
  onSelect,
}: {
  plans: ActionPlanRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="compact-list">
      {plans.map((plan) => (
        <button
          key={plan.id}
          type="button"
          className={`action-list-row${selectedId === plan.id ? " selected" : ""}`}
          onClick={() => onSelect(plan.id)}
        >
          <div>
            <div className="action-list-title">{planTitle(plan)}</div>
            <div className="action-list-sub">
              {humanClient(plan.sourceClient)} · {systemLabel(plan)} · {formatRelativeTime(plan.createdAt)}
            </div>
          </div>
          <StatusBadge status={plan.status} label={humanActionStatus(plan.status)} />
        </button>
      ))}
    </div>
  );
}
