import { useEffect, useMemo, useState } from "react";
import { ChartColumn } from "lucide-react";
import type { UsageInteraction, UsageRecord } from "@infra/shared";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  MetricGrid,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatCurrency,
  formatDate,
} from "../components";
import { usePortalCompany } from "./usePortalCompany";
import { api, type CompanyUsageResponse } from "../api";
import { humanClient, humanOperation } from "../lib/format";

export default function PortalUsagePage() {
  const { company, loading: companyLoading, error: companyError } = usePortalCompany();
  const [usage, setUsage] = useState<CompanyUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    if (!company) return;
    void (async () => {
      try {
        setUsage(await api.getCompanyUsage(company.slug, 50));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load usage");
      } finally {
        setLoading(false);
      }
    })();
  }, [company]);

  const interactions = useMemo(() => {
    if (!usage) return [];
    if (usage.interactions?.length) return usage.interactions;
    return usage.records.map((record) => fallbackInteraction(record));
  }, [usage]);

  if (companyLoading || loading) return <LoadingState />;
  if (companyError || error || !company || !usage) {
    return (
      <ErrorState
        title="Unable to load usage"
        description={companyError ?? error ?? undefined}
      />
    );
  }

  const { summary } = usage;

  return (
    <>
      <PageHeader
        title="Usage"
        description="What your company used, who used it, and why it was charged."
      />

      <MetricGrid cols={4}>
        <MetricCard label="Requests today" value={summary.requestsToday} />
        <MetricCard label="This month" value={summary.requestsThisMonth} />
        <MetricCard label="Successful" value={summary.successfulThisMonth} />
        <MetricCard label="Failed" value={summary.failedThisMonth} />
      </MetricGrid>

      <SectionCard
        title="Recent activity"
        description="Each row is one conversation turn when we can tell the steps belong together. Otherwise each action is shown separately."
      >
        {interactions.length === 0 ? (
          <EmptyState
            icon={<ChartColumn size={28} />}
            title="No usage recorded yet"
            description="Usage will appear after the first request passes through INFRA."
          />
        ) : (
          <div className="interaction-list">
            {interactions.map((item) => {
              const open = openId === item.id;
              const showDetail = detailId === item.id;
              return (
                <article key={item.id} className="interaction-card">
                  <button
                    type="button"
                    className="interaction-summary"
                    onClick={() => setOpenId(open ? null : item.id)}
                    aria-expanded={open}
                  >
                    <div>
                      <div className="interaction-when">{formatDate(item.createdAt)}</div>
                      <div className="muted small">{humanClient(item.clientKind)}</div>
                    </div>
                    <div className="interaction-main">
                      <strong>{item.label}</strong>
                      <div className="muted small">
                        {item.actorLabel ? `${item.actorLabel} · ` : ""}
                        {item.operationCount === 1
                          ? "1 operation"
                          : `${item.operationCount} operations`}
                      </div>
                    </div>
                    <div className="interaction-meta">
                      <StatusBadge
                        status={item.status === "error" ? "failed" : "completed"}
                      />
                      <div className="num interaction-charge">
                        {formatCurrency(item.customerChargeCents)}
                      </div>
                    </div>
                  </button>

                  {open ? (
                    <div className="interaction-body">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>What happened</th>
                            <th className="num">Charge</th>
                            <th>Result</th>
                          </tr>
                        </thead>
                        <tbody>
                          {item.operations.map((op) => (
                            <tr key={op.id}>
                              <td>{humanOperation(op.action, op.toolName)}</td>
                              <td className="num">
                                {op.customerChargeCents != null
                                  ? formatCurrency(op.customerChargeCents)
                                  : "—"}
                              </td>
                              <td>
                                <StatusBadge
                                  status={op.success === false ? "failed" : "completed"}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>

                      <button
                        type="button"
                        className="button button-ghost button-small"
                        onClick={() => setDetailId(showDetail ? null : item.id)}
                      >
                        {showDetail ? "Hide details" : "View details"}
                      </button>

                      {showDetail ? (
                        <dl className="interaction-details">
                          <div>
                            <dt>Who used it</dt>
                            <dd>{item.actorLabel ?? humanClient(item.clientKind)}</dd>
                          </div>
                          <div>
                            <dt>Provider cost</dt>
                            <dd>
                              {item.providerCostKnown && item.providerCostCents != null
                                ? formatCurrency(item.providerCostCents)
                                : "Unavailable"}
                            </dd>
                          </div>
                          <div>
                            <dt>Why this charge</dt>
                            <dd>
                              {item.operationCount === 1
                                ? "This is the TEST price for that action."
                                : "The total is the sum of each priced action in this request."}
                            </dd>
                          </div>
                        </dl>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </SectionCard>
    </>
  );
}

function fallbackInteraction(record: UsageRecord): UsageInteraction {
  return {
    id: record.interactionId ?? record.id,
    companyId: record.companyId,
    actorType: record.userId ? "user" : "service",
    actorId: record.userId ?? null,
    actorLabel: record.actorEmail ?? null,
    clientKind: record.sourceClient ?? "unknown",
    mcpId: record.mcpEnvironmentId ?? null,
    mcpSessionId: record.mcpSessionId ?? null,
    label: humanOperation(record.action, record.toolName),
    status: record.success === false ? "error" : "completed",
    currency: "GBP",
    operationCount: 1,
    customerChargeCents: record.customerChargeCents ?? 0,
    providerCostCents: record.underlyingCostCents ?? null,
    providerCostKnown: record.costBasis === "actual",
    createdAt: record.recordedAt,
    updatedAt: record.recordedAt,
    operations: [record],
  };
}
