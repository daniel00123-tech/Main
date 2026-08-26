import { useEffect, useState } from "react";
import { api } from "../api";
import {
  ErrorState,
  KeyValue,
  LoadingState,
  MetricCard,
  MetricGrid,
  Notice,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatCurrency,
  formatDate,
} from "../components";

export default function PricingRulesPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getPricingRules>> | null>(
    null,
  );
  const [exceptions, setExceptions] = useState(0);
  const [reconcileNote, setReconcileNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [rules, summary] = await Promise.all([
        api.getPricingRules(),
        api.getCommercialSummary().catch(() => null),
      ]);
      setData(rules);
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

  async function runReconciliation() {
    setBusy(true);
    setReconcileNote(null);
    try {
      const result = await api.runReconciliation();
      setReconcileNote(
        `Reconciliation complete. Healed ${result.healedLinks ?? 0} settlement link(s). Opened ${result.exceptionsCreated} exception(s). No historic auto-debits.`,
      );
      await load();
    } catch (err) {
      setReconcileNote(err instanceof Error ? err.message : "Reconciliation failed");
    } finally {
      setBusy(false);
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

  const platformPolicy =
    data.policies.find((p) => !p.companyId && p.enabled) ?? data.policies[0];

  return (
    <>
      <PageHeader
        title="Pricing rules"
        description="Target gross margin, minimum charge, and per-operation commercial rules. Historic transactions keep the rate/rule version used at the time."
        actions={
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => void runReconciliation()}>
            Run reconciliation
          </button>
        }
      />

      {reconcileNote ? <Notice tone="info">{reconcileNote}</Notice> : null}
      {exceptions > 0 ? (
        <Notice tone="warning">
          {exceptions} open financial integrity exception(s). Ledger remains the source of truth —
          corrections use compensating entries only.
        </Notice>
      ) : null}

      <MetricGrid cols={3}>
        <MetricCard
          label="Target gross margin"
          value={
            platformPolicy
              ? `${((platformPolicy.targetMarginBps ?? 6000) / 100).toFixed(0)}%`
              : "60%"
          }
          hint="customer_charge = cost ÷ (1 − margin)"
        />
        <MetricCard
          label="Minimum customer charge"
          value={formatCurrency(platformPolicy?.minimumChargeCents ?? 1)}
          hint="Applies when calculated selling price is lower"
        />
        <MetricCard
          label="Active rules"
          value={String(data.rules.filter((r) => r.enabled).length)}
        />
      </MetricGrid>

      <SectionCard
        title="Platform commercial policy"
        description="Default target margin is 60% gross margin — not a 60% markup."
        className="mt-6"
      >
        {platformPolicy ? (
          <>
            <KeyValue label="Label" value={platformPolicy.label ?? "Platform default"} />
            <KeyValue
              label="Target margin"
              value={`${(platformPolicy.targetMarginBps / 100).toFixed(2)}%`}
            />
            <KeyValue
              label="Minimum charge"
              value={formatCurrency(platformPolicy.minimumChargeCents, platformPolicy.currency)}
            />
            <KeyValue
              label="Effective from"
              value={formatDate(platformPolicy.effectiveFrom)}
            />
            <KeyValue
              label="Test configuration"
              value={platformPolicy.isTestConfig ? "Yes — test rates active" : "No"}
            />
            <KeyValue
              label="Status"
              value={<StatusBadge status={platformPolicy.enabled ? "active" : "disabled"} />}
            />
          </>
        ) : (
          <p className="muted">No platform policy seeded yet.</p>
        )}
      </SectionCard>

      <SectionCard
        title="Operation rules"
        description="Company-specific and promotional/test overrides appear here when configured."
        className="mt-6"
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Operation</th>
                <th>Mode</th>
                <th>Charge</th>
                <th>Margin</th>
                <th>Min</th>
                <th>Scope</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.rules.map((rule) => (
                <tr key={rule.id}>
                  <td>
                    <strong>{humanise(rule.action)}</strong>
                    {rule.label ? <div className="muted small">{rule.label}</div> : null}
                    {rule.versionLabel ? (
                      <div className="muted small mono">{rule.versionLabel}</div>
                    ) : null}
                  </td>
                  <td className="muted">{rule.pricingMode}</td>
                  <td className="num">
                    {rule.fixedChargeCents != null
                      ? formatCurrency(rule.fixedChargeCents)
                      : "Derived"}
                  </td>
                  <td className="num">
                    {rule.targetMarginBps != null
                      ? `${(rule.targetMarginBps / 100).toFixed(0)}%`
                      : "Policy"}
                  </td>
                  <td className="num">
                    {rule.minimumChargeCents != null
                      ? formatCurrency(rule.minimumChargeCents)
                      : "Policy"}
                  </td>
                  <td className="muted">
                    {rule.companyId ? "Company" : "Platform"}
                    {rule.isTestConfig ? " · Test" : ""}
                  </td>
                  <td>
                    <StatusBadge status={rule.enabled ? "active" : "disabled"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </>
  );
}

function humanise(value: string): string {
  return value.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
