import { Fragment, FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import {
  AdvancedDetails,
  Button,
  ErrorState,
  KpiStrip,
  LoadingState,
  Modal,
  Notice,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatCurrency,
  formatDate,
  toast,
} from "../components";
import { humanOperation } from "../lib/format";

type PricingData = Awaited<ReturnType<typeof api.getPricingRules>>;
type Company = Awaited<ReturnType<typeof api.getCompanies>>[number];

export default function PricingRulesPage() {
  const [data, setData] = useState<PricingData | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [exceptions, setExceptions] = useState(0);
  const [reconcileNote, setReconcileNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedRule, setExpandedRule] = useState<string | null>(null);
  const [policyModal, setPolicyModal] = useState<{
    companyId: string | null;
    companyName: string;
  } | null>(null);
  const [policyForm, setPolicyForm] = useState({
    marginPercent: "60",
    minimumPence: "1",
    label: "",
  });
  const [previewAction, setPreviewAction] = useState("knowledge.read");
  const [previewCostPence, setPreviewCostPence] = useState("0.4");
  const [previewCompanyId, setPreviewCompanyId] = useState<string>("");
  const [previewResult, setPreviewResult] = useState<Awaited<
    ReturnType<typeof api.previewPricing>
  > | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [rules, companyList, summary] = await Promise.all([
        api.getPricingRules(),
        api.getCompanies(),
        api.getCommercialSummary().catch(() => null),
      ]);
      setData(rules);
      setCompanies(companyList);
      setExceptions(summary?.openIntegrityExceptions ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load pricing rules");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const platformPolicy = useMemo(
    () => data?.policies.find((p) => !p.companyId && p.enabled) ?? data?.policies[0] ?? null,
    [data],
  );

  const companyPolicies = useMemo(
    () =>
      (data?.policies ?? []).filter((p) => p.companyId && p.enabled).map((p) => ({
        ...p,
        companyName:
          companies.find((c) => c.id === p.companyId)?.name ?? p.companyId ?? "Company",
      })),
    [data, companies],
  );

  async function runReconciliation() {
    setBusy(true);
    setReconcileNote(null);
    try {
      const result = await api.runReconciliation();
      setReconcileNote(
        `Reconciliation complete. Healed ${result.healedLinks ?? 0} settlement link(s). Opened ${result.exceptionsCreated} exception(s).`,
      );
      await load();
    } catch (err) {
      setReconcileNote(err instanceof Error ? err.message : "Reconciliation failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitPolicy(event: FormEvent) {
    event.preventDefault();
    if (!policyModal) return;
    const margin = Number(policyForm.marginPercent);
    const minimum = Number(policyForm.minimumPence);
    if (!Number.isFinite(margin) || margin < 0 || margin >= 100) {
      toast("Margin must be between 0 and 99", "error");
      return;
    }
    setBusy(true);
    try {
      await api.createPricingPolicy({
        companyId: policyModal.companyId,
        targetMarginBps: Math.round(margin * 100),
        minimumChargeCents: Math.round(minimum),
        label:
          policyForm.label.trim() ||
          (policyModal.companyId
            ? `${policyModal.companyName} pricing override`
            : "Platform default pricing policy"),
      });
      toast("Pricing policy updated");
      setPolicyModal(null);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to update policy", "error");
    } finally {
      setBusy(false);
    }
  }

  async function runPreview() {
    setPreviewBusy(true);
    try {
      const costMicros = Math.round(Number(previewCostPence) * 10_000);
      const result = await api.previewPricing({
        companyId: previewCompanyId || null,
        action: previewAction,
        underlyingCostMicros: Number.isFinite(costMicros) ? costMicros : null,
      });
      setPreviewResult(result);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Preview failed", "error");
    } finally {
      setPreviewBusy(false);
    }
  }

  if (loading) return <LoadingState label="Loading pricing rules…" />;
  if (error || !data) {
    return (
      <ErrorState
        title="Unable to load pricing rules"
        description={error ?? undefined}
        onRetry={() => void load()}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Pricing rules"
        description="Commercial policy, action pricing, and company-specific overrides. Historic transactions retain the rate version used at the time."
        actions={
          <Button variant="secondary" disabled={busy} onClick={() => void runReconciliation()}>
            Run reconciliation
          </Button>
        }
      />

      {reconcileNote ? <Notice tone="info">{reconcileNote}</Notice> : null}
      {exceptions > 0 ? (
        <Notice tone="warning">
          {exceptions} open financial integrity exception(s). Corrections use compensating ledger
          entries only.
        </Notice>
      ) : null}

      <KpiStrip
        items={[
          {
            label: "Default target margin",
            value: platformPolicy
              ? `${(platformPolicy.targetMarginBps / 100).toFixed(0)}%`
              : "60%",
          },
          {
            label: "Minimum action charge",
            value: formatCurrency(platformPolicy?.minimumChargeCents ?? 1),
          },
          {
            label: "Active action rules",
            value: data.rules.filter((r) => r.enabled).length,
          },
          {
            label: "Company overrides",
            value: companyPolicies.length,
          },
        ]}
      />

      <SectionCard
        title="Platform commercial policy"
        description="Default margin and minimum charge apply prospectively from the effective date."
        className="mt-6"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setPolicyModal({ companyId: null, companyName: "Platform default" });
              setPolicyForm({
                marginPercent: platformPolicy
                  ? String(platformPolicy.targetMarginBps / 100)
                  : "60",
                minimumPence: String(platformPolicy?.minimumChargeCents ?? 1),
                label: "Platform default pricing policy",
              });
            }}
          >
            Edit default policy
          </Button>
        }
      >
        {platformPolicy ? (
          <div className="grid grid-3">
            <div>
              <div className="muted small">Target gross margin</div>
              <div style={{ fontWeight: 700, fontSize: "var(--text-xl)" }}>
                {(platformPolicy.targetMarginBps / 100).toFixed(0)}%
              </div>
            </div>
            <div>
              <div className="muted small">Minimum customer charge</div>
              <div style={{ fontWeight: 700, fontSize: "var(--text-xl)" }}>
                {formatCurrency(platformPolicy.minimumChargeCents, platformPolicy.currency)}
              </div>
            </div>
            <div>
              <div className="muted small">Effective from</div>
              <div style={{ fontWeight: 600 }}>{formatDate(platformPolicy.effectiveFrom)}</div>
            </div>
          </div>
        ) : (
          <p className="muted">No platform policy seeded yet.</p>
        )}
        <AdvancedDetails label="How pricing works">
          <p className="muted small">
            Customer charge is derived from underlying provider cost and target gross margin, then
            rounded up to the minimum charge where applicable. Formula: charge = cost ÷ (1 −
            margin). This is Platform Admin information only — customers never see margin or
            provider cost.
          </p>
        </AdvancedDetails>
      </SectionCard>

      <SectionCard
        title="Company-specific margins"
        description="Override the platform default for individual customers. Prior versions remain on historic transactions."
        className="mt-6"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const first = companies[0];
              if (!first) return;
              setPolicyModal({ companyId: first.id, companyName: first.name });
              setPolicyForm({
                marginPercent: "60",
                minimumPence: "1",
                label: `${first.name} pricing override`,
              });
            }}
            disabled={companies.length === 0}
          >
            Add company override
          </Button>
        }
      >
        {companyPolicies.length === 0 ? (
          <p className="muted">All companies use the platform default margin.</p>
        ) : (
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Company</th>
                  <th className="num">Target margin</th>
                  <th className="num">Minimum charge</th>
                  <th>Effective from</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {companyPolicies.map((policy) => (
                  <tr key={policy.id}>
                    <td>{policy.companyName}</td>
                    <td className="num">{(policy.targetMarginBps / 100).toFixed(0)}%</td>
                    <td className="num">
                      {formatCurrency(policy.minimumChargeCents, policy.currency)}
                    </td>
                    <td>{formatDate(policy.effectiveFrom)}</td>
                    <td>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setPolicyModal({
                            companyId: policy.companyId,
                            companyName: policy.companyName,
                          });
                          setPolicyForm({
                            marginPercent: String(policy.targetMarginBps / 100),
                            minimumPence: String(policy.minimumChargeCents),
                            label: policy.label ?? "",
                          });
                        }}
                      >
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Action pricing" description="Per-operation commercial rules." className="mt-6">
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th>Action</th>
                <th>Pricing method</th>
                <th className="num">Customer charge</th>
                <th className="num">Target margin</th>
                <th>Scope</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.rules.map((rule) => (
                <Fragment key={rule.id}>
                  <tr
                    style={{ cursor: "pointer" }}
                    onClick={() => setExpandedRule(expandedRule === rule.id ? null : rule.id)}
                  >
                    <td>
                      <strong>{humanOperation(rule.action)}</strong>
                      {rule.label ? <div className="muted small">{rule.label}</div> : null}
                    </td>
                    <td className="muted">
                      {rule.pricingMode === "fixed" ? "Fixed" : "Calculated"}
                    </td>
                    <td className="num">
                      {rule.fixedChargeCents != null
                        ? formatCurrency(rule.fixedChargeCents)
                        : "Derived"}
                    </td>
                    <td className="num">
                      {rule.targetMarginBps != null
                        ? `${(rule.targetMarginBps / 100).toFixed(0)}%`
                        : "Policy default"}
                    </td>
                    <td className="muted">
                      {rule.companyId ? "Company override" : "Platform default"}
                      {rule.isTestConfig ? " · Test" : ""}
                    </td>
                    <td>
                      <StatusBadge status={rule.enabled ? "healthy" : "disabled"} />
                    </td>
                  </tr>
                  {expandedRule === rule.id ? (
                    <tr key={`${rule.id}-detail`} className="expand-row">
                      <td colSpan={6}>
                        <span className="mono small muted">Technical ID: {rule.action}</span>
                        {rule.versionLabel ? (
                          <span className="mono small muted" style={{ marginLeft: 12 }}>
                            Version: {rule.versionLabel}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        title="Pricing preview"
        description="Uses the same backend pricing engine as live charging."
        className="mt-6"
      >
        <div className="grid grid-3" style={{ gap: 12, marginBottom: 12 }}>
          <label className="field">
            <span>Action</span>
            <select value={previewAction} onChange={(e) => setPreviewAction(e.target.value)}>
              {data.rules.map((r) => (
                <option key={r.id} value={r.action}>
                  {humanOperation(r.action)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Underlying cost (pence)</span>
            <input
              type="number"
              step="0.01"
              value={previewCostPence}
              onChange={(e) => setPreviewCostPence(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Company (optional)</span>
            <select
              value={previewCompanyId}
              onChange={(e) => setPreviewCompanyId(e.target.value)}
            >
              <option value="">Platform default</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <Button variant="secondary" loading={previewBusy} onClick={() => void runPreview()}>
          Calculate preview
        </Button>
        {previewResult ? (
          <div className="kpi-strip" style={{ marginTop: 16 }}>
            <div className="kpi-item">
              <div className="kpi-item-label">Underlying cost</div>
              <div className="kpi-item-value">
                {formatCurrency(previewResult.underlyingCostCents ?? 0)}
              </div>
            </div>
            <div className="kpi-item">
              <div className="kpi-item-label">Target margin</div>
              <div className="kpi-item-value">
                {(previewResult.targetMarginBps / 100).toFixed(0)}%
              </div>
            </div>
            <div className="kpi-item">
              <div className="kpi-item-label">Calculated price</div>
              <div className="kpi-item-value">
                {formatCurrency(previewResult.calculatedPriceCents)}
              </div>
            </div>
            <div className="kpi-item">
              <div className="kpi-item-label">Minimum charge</div>
              <div className="kpi-item-value">
                {formatCurrency(previewResult.minimumChargeCents)}
              </div>
            </div>
            <div className="kpi-item">
              <div className="kpi-item-label">Final customer charge</div>
              <div className="kpi-item-value">
                {formatCurrency(previewResult.finalCustomerChargeCents)}
                {previewResult.minimumApplied ? (
                  <div className="kpi-item-hint">Minimum applied</div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </SectionCard>

      <Modal
        open={Boolean(policyModal)}
        onClose={() => setPolicyModal(null)}
        title={
          policyModal?.companyId
            ? `Company pricing — ${policyModal.companyName}`
            : "Platform default pricing"
        }
        description="Creates a new versioned policy. Historic transactions are not recalculated."
      >
        <form onSubmit={(e) => void submitPolicy(e)} className="stack">
          {policyModal?.companyId ? (
            <label className="field">
              <span>Company</span>
              <select
                value={policyModal.companyId}
                onChange={(e) => {
                  const company = companies.find((c) => c.id === e.target.value);
                  if (company) {
                    setPolicyModal({ companyId: company.id, companyName: company.name });
                  }
                }}
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field">
            <span>Target gross margin (%)</span>
            <input
              type="number"
              min="0"
              max="99"
              step="1"
              value={policyForm.marginPercent}
              onChange={(e) => setPolicyForm((f) => ({ ...f, marginPercent: e.target.value }))}
              required
            />
          </label>
          <label className="field">
            <span>Minimum customer charge (pence)</span>
            <input
              type="number"
              min="0"
              step="1"
              value={policyForm.minimumPence}
              onChange={(e) => setPolicyForm((f) => ({ ...f, minimumPence: e.target.value }))}
              required
            />
          </label>
          <label className="field">
            <span>Label</span>
            <input
              value={policyForm.label}
              onChange={(e) => setPolicyForm((f) => ({ ...f, label: e.target.value }))}
            />
          </label>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button type="button" variant="secondary" onClick={() => setPolicyModal(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Confirm & apply
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
