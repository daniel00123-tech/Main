import { Fragment, useEffect, useMemo, useState } from "react";
import { ChartColumn } from "lucide-react";
import type { UsageInteraction, UsageRecord } from "@infra/shared";
import { buildUsageSpendSummary } from "@infra/shared";
import {
  CollapsibleBlock,
  Drawer,
  EmptyState,
  FilterBar,
  LoadingState,
  MobileRecordCard,
  MobileRecordList,
  SearchInput,
  SectionCard,
  Select,
  ShowMoreFooter,
  StatusBadge,
  formatCurrency,
  formatDate,
  useIsMobile,
} from "../components";
import { usePortalCompany } from "./usePortalCompany";
import { api, type CompanyUsageResponse } from "../api";
import {
  formatNumber,
  humanActor,
  humanClient,
  humanOperation,
  integrationLabel,
  usageSuccessRate,
} from "../lib/format";
import { PortalPageBody, PortalPageHeader } from "./components";

export default function PortalUsagePage() {
  const { company, loading: companyLoading, error: companyError } = usePortalCompany();
  const [usage, setUsage] = useState<CompanyUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [detailItem, setDetailItem] = useState<UsageInteraction | null>(null);
  const [displayLimit, setDisplayLimit] = useState(25);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!company) return;
    void (async () => {
      try {
        setUsage(await api.getCompanyUsage(company.slug, 100));
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return interactions.filter((item) => {
      if (sourceFilter && item.clientKind !== sourceFilter) return false;
      if (statusFilter === "success" && item.status === "error") return false;
      if (statusFilter === "failed" && item.status !== "error") return false;
      if (statusFilter === "denied" && !item.operations.some((op) => op.settlementStatus === "denied")) {
        return false;
      }
      if (!q) return true;
      return (
        item.label.toLowerCase().includes(q) ||
        humanClient(item.clientKind).toLowerCase().includes(q) ||
        (item.actorLabel ?? "").toLowerCase().includes(q)
      );
    });
  }, [interactions, query, sourceFilter, statusFilter]);

  const visible = filtered.slice(0, displayLimit);

  useEffect(() => {
    setDisplayLimit(25);
  }, [query, sourceFilter, statusFilter]);

  if (companyLoading || !company) return <LoadingState label="Loading usage…" />;

  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const spendSummary = buildUsageSpendSummary(interactions, monthStart);
  const summary = usage?.summary;
  const successRate = summary
    ? usageSuccessRate(summary.successfulThisMonth, summary.requestsThisMonth)
    : "—";

  return (
    <div className="portal-page">
      <PortalPageHeader
        title="Usage"
        description="What your company used and what it cost this month."
      />

      <PortalPageBody
        loading={loading}
        error={error ?? companyError}
        loadingLabel="Loading usage…"
        errorTitle="We couldn't load your usage"
      >
        <div className="portal-usage-summary card">
          <div className="portal-usage-summary-row portal-usage-summary-total">
            <span className="muted small">This month</span>
            <strong>{formatCurrency(spendSummary.totalCents)}</strong>
          </div>
          <div className="portal-usage-summary-grid">
            <div className="portal-usage-summary-row">
              <span className="muted small">AI</span>
              <strong>{formatCurrency(spendSummary.aiCents)}</strong>
            </div>
            <div className="portal-usage-summary-row">
              <span className="muted small">Automations</span>
              <strong>{formatCurrency(spendSummary.automationsCents)}</strong>
            </div>
            <div className="portal-usage-summary-row">
              <span className="muted small">Other services</span>
              <strong>{formatCurrency(spendSummary.otherCents)}</strong>
            </div>
          </div>
          <p className="muted small portal-usage-summary-meta">
            {formatNumber(summary?.requestsThisMonth ?? 0)} requests · {successRate} success rate
            {summary?.deniedThisMonth
              ? ` · ${formatNumber(summary.deniedThisMonth)} denied`
              : ""}
            {summary?.billableThisMonth != null
              ? ` · ${formatNumber(summary.billableThisMonth)} billable`
              : ""}
          </p>
        </div>

        {summary?.byUser?.length || summary?.byChannel?.length || summary?.byConnector?.length ? (
          <div className="portal-usage-summary card" style={{ marginTop: 12 }}>
            <div className="portal-usage-summary-grid">
              <div>
                <span className="muted small">By user</span>
                <ul className="plain-list small" style={{ margin: "8px 0 0" }}>
                  {(summary.byUser ?? []).slice(0, 6).map((row) => (
                    <li key={row.key}>
                      {humanActor(row.label)} · {formatNumber(row.requests)}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <span className="muted small">By channel</span>
                <ul className="plain-list small" style={{ margin: "8px 0 0" }}>
                  {(summary.byChannel ?? []).slice(0, 6).map((row) => (
                    <li key={row.key}>
                      {humanClient(row.label)} · {formatNumber(row.requests)}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <span className="muted small">By connector</span>
                <ul className="plain-list small" style={{ margin: "8px 0 0" }}>
                  {(summary.byConnector ?? []).slice(0, 6).map((row) => (
                    <li key={row.key}>
                      {row.label} · {formatNumber(row.requests)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ) : null}

        <CollapsibleBlock title="Understanding your usage" summary="What these numbers mean">
          <p className="muted small" style={{ margin: 0 }}>
            Charges reflect INFRA usage recorded against your company balance. AI activity through
            ChatGPT or Claude is usually the largest category. Focus on failed requests if the
            success rate drops unexpectedly.
          </p>
        </CollapsibleBlock>

      <FilterBar>
        <SearchInput value={query} onChange={setQuery} placeholder="Search activity…" />
        <Select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
          <option value="">All sources</option>
          <option value="chatgpt">ChatGPT</option>
          <option value="claude">Claude</option>
          <option value="portal">Portal</option>
          <option value="portal_chat">Portal Chat</option>
        </Select>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All results</option>
          <option value="success">Successful</option>
          <option value="failed">Failed</option>
          <option value="denied">Denied</option>
        </Select>
      </FilterBar>

      <SectionCard title="Recent activity">
        {visible.length === 0 ? (
          <EmptyState
            icon={<ChartColumn size={28} />}
            title="No usage recorded yet"
            description="Usage will appear after the first request passes through INFRA."
          />
        ) : isMobile ? (
          <MobileRecordList>
            {visible.map((item) => (
              <MobileRecordCard key={item.id} onClick={() => setDetailItem(item)}>
                <div className="mobile-record-header">
                  <div className="mobile-record-title">{item.label}</div>
                  <StatusBadge status={item.status === "error" ? "failed" : "completed"} />
                </div>
                <dl className="mobile-record-meta">
                  <div>
                    <dt>When</dt>
                    <dd>{formatDate(item.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>{humanClient(item.clientKind)}</dd>
                  </div>
                  <div>
                    <dt>Charge</dt>
                    <dd>{formatCurrency(item.customerChargeCents)}</dd>
                  </div>
                </dl>
              </MobileRecordCard>
            ))}
          </MobileRecordList>
        ) : (
          <div className="table-wrap usage-table-compact">
            <table className="table compact">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Activity</th>
                  <th>Source</th>
                  <th>Result</th>
                  <th className="num">Charge</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => {
                  const open = openId === item.id;
                  return (
                    <Fragment key={item.id}>
                      <tr
                        style={{ cursor: "pointer" }}
                        onClick={() => setOpenId(open ? null : item.id)}
                      >
                        <td className="muted small">{formatDate(item.createdAt)}</td>
                        <td>
                          <strong>{item.label}</strong>
                          <div className="muted small">
                            {humanActor(item.actorLabel)} ·{" "}
                            {item.operationCount === 1
                              ? "1 step"
                              : `${item.operationCount} steps`}
                          </div>
                        </td>
                        <td>{humanClient(item.clientKind)}</td>
                        <td>
                          <StatusBadge status={item.status === "error" ? "failed" : "completed"} />
                        </td>
                        <td className="num">{formatCurrency(item.customerChargeCents)}</td>
                      </tr>
                      {open ? (
                        <tr>
                          <td colSpan={5}>
                            <div className="interaction-body" style={{ padding: "8px 0" }}>
                              <table className="table compact">
                                <thead>
                                  <tr>
                                    <th>Step</th>
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
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <ShowMoreFooter
          shown={visible.length}
          total={filtered.length}
          onShowMore={() => setDisplayLimit((n) => n + 25)}
        />
      </SectionCard>
      </PortalPageBody>

      <Drawer
        open={Boolean(detailItem)}
        onClose={() => setDetailItem(null)}
        title="Activity details"
      >
        {detailItem ? (
          <>
            <p>
              <strong>{detailItem.label}</strong>
            </p>
            <dl className="mobile-record-meta">
              <div>
                <dt>Who</dt>
                <dd>{humanActor(detailItem.actorLabel)}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{humanClient(detailItem.clientKind)}</dd>
              </div>
              <div>
                <dt>When</dt>
                <dd>{formatDate(detailItem.createdAt)}</dd>
              </div>
              <div>
                <dt>Total charge</dt>
                <dd>{formatCurrency(detailItem.customerChargeCents)}</dd>
              </div>
            </dl>
            <h4>Steps</h4>
            <ul className="plain-list">
              {detailItem.operations.map((op) => (
                <li key={op.id}>
                  {humanOperation(op.action, op.toolName)} —{" "}
                  {integrationLabel(op.action, op.toolName)}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Drawer>
    </div>
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
