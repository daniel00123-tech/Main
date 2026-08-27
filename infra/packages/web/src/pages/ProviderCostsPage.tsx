import { Fragment, useEffect, useMemo, useState } from "react";
import { Cloud, RefreshCw } from "lucide-react";
import { api } from "../api";
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatDate,
  toast,
} from "../components";

type ProviderCard = Awaited<ReturnType<typeof api.getProviderCosts>>["cards"][number];

type ProviderMeta = {
  label: string;
  category: string;
  customerAttributable: string;
  notes: string;
};

const PROVIDER_META: Record<string, ProviderMeta> = {
  cloudflare: {
    label: "Cloudflare",
    category: "Platform infrastructure",
    customerAttributable: "Partially",
    notes: "CDN, Workers, and edge infrastructure for the platform.",
  },
  openai: {
    label: "OpenAI API",
    category: "Direct usage cost",
    customerAttributable: "API usage only",
    notes:
      "Only where INFRA pays OpenAI API charges. Customer ChatGPT subscriptions are not an INFRA cost.",
  },
  anthropic: {
    label: "Anthropic API",
    category: "Direct usage cost",
    customerAttributable: "API usage only",
    notes:
      "Only where INFRA pays Anthropic API charges. Customer Claude subscriptions are not an INFRA cost.",
  },
  cursor: {
    label: "Cursor",
    category: "Development / operating cost",
    customerAttributable: "No",
    notes:
      "Development overhead — not allocated to individual customer AI requests.",
  },
};

function nextReviewDate(fromIso: string | null | undefined): string {
  const base = fromIso ? new Date(fromIso) : new Date();
  const next = new Date(base);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString();
}

export default function ProviderCostsPage() {
  const [cards, setCards] = useState<ProviderCard[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [reviews, setReviews] = useState<
    Awaited<ReturnType<typeof api.getPricingReviews>>["reviews"]
  >([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [itemDrafts, setItemDrafts] = useState<
    Record<string, Record<string, string>>
  >({});

  async function saveDraftItems(cardId: string, items: ProviderCard["items"]) {
    setBusyProvider(cardId);
    try {
      const drafts = itemDrafts[cardId] ?? {};
      await api.updateProviderRateCardItems(
        cardId,
        items.map((item) => ({
          id: item.id,
          unitCostMicros: Math.round(Number(drafts[item.id] ?? item.unitCostMicros / 10_000) * 10_000),
          notes: item.notes,
        })),
      );
      toast("Unit costs saved");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to save unit costs", "error");
    } finally {
      setBusyProvider(null);
    }
  }

  async function approveCard(cardId: string) {
    setBusyProvider(cardId);
    try {
      await api.approveProviderRateCard(cardId);
      toast("Rate card approved");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to approve rate card", "error");
    } finally {
      setBusyProvider(null);
    }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [costs, pricingReviews] = await Promise.all([
        api.getProviderCosts(),
        api.getPricingReviews().catch(() => ({ reviews: [] })),
      ]);
      setCards(costs.cards);
      setNote(costs.nextReviewNote);
      setReviews(pricingReviews.reviews);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load provider costs");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function requestReview(provider: string) {
    setBusyProvider(provider);
    try {
      await api.requestProviderPricingReview(provider, {
        notes: "Monthly provider pricing review requested from Platform Admin",
      });
      toast(`Pricing review proposed for ${PROVIDER_META[provider]?.label ?? provider}`);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Review request failed", "error");
    } finally {
      setBusyProvider(null);
    }
  }

  const tableRows = useMemo(() => {
    const byProvider = new Map<string, ProviderCard[]>();
    for (const entry of cards) {
      const list = byProvider.get(entry.card.provider) ?? [];
      list.push(entry);
      byProvider.set(entry.card.provider, list);
    }

    const providers = ["cloudflare", "openai", "anthropic", "cursor"] as const;
    return providers.map((provider) => {
      const meta = PROVIDER_META[provider];
      const entries = byProvider.get(provider) ?? [];
      const active =
        entries.find((e) => e.card.status === "active") ??
        entries.find((e) => e.card.status === "draft") ??
        entries[0];
      const lastReview = active?.card.verifiedAt ?? active?.card.updatedAt ?? null;
      const hasRates = active?.items.some((i) => i.unitCostMicros > 0) ?? false;
      const pendingReview = reviews.find(
        (r) => r.provider === provider && r.status === "pending",
      );

      return {
        provider,
        meta,
        active,
        lastReview,
        nextReview: nextReviewDate(lastReview),
        hasRates,
        pendingReview,
        costStatus:
          provider === "cursor"
            ? "Tracked manually"
            : hasRates
              ? "Configured"
              : active
                ? "Not configured"
                : "Not currently used",
        currentSpend: "—" as const,
      };
    });
  }, [cards, reviews]);

  if (loading) return <LoadingState label="Loading provider costs…" />;
  if (error) {
    return (
      <ErrorState
        title="Unable to load provider costs"
        description={error}
        onRetry={() => void load()}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Provider costs"
        description="Underlying infrastructure costs INFRA may pay. Customer-owned AI subscriptions (ChatGPT, Claude) are not included unless INFRA pays API usage directly."
      />

      {note ? <Notice tone="info">{note}</Notice> : null}

      <Notice tone="info">
        Provider rate changes require Platform Admin approval before customer pricing is affected.
        Cursor development spend is platform operating expenditure, not per-request provider cost.
      </Notice>

      <SectionCard title="Cost overview" className="mt-6">
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Category</th>
                <th>Cost status</th>
                <th className="num">Current spend</th>
                <th>Customer attributable?</th>
                <th>Last reviewed</th>
                <th>Next review</th>
                <th>Pricing change</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row) => (
                <Fragment key={row.provider}>
                  <tr key={row.provider}>
                    <td>
                      <strong>{row.meta.label}</strong>
                      <div className="cost-category muted small">{row.meta.notes}</div>
                    </td>
                    <td className="muted">{row.meta.category}</td>
                    <td>
                      <StatusBadge
                        status={
                          row.provider === "cursor"
                            ? "configured"
                            : row.hasRates
                              ? "healthy"
                              : "not_configured"
                        }
                        label={row.costStatus}
                      />
                    </td>
                    <td className="num muted">{row.currentSpend}</td>
                    <td className="muted">{row.meta.customerAttributable}</td>
                    <td>{row.lastReview ? formatDate(row.lastReview) : "—"}</td>
                    <td>{formatDate(row.nextReview)}</td>
                    <td>
                      {row.pendingReview ? (
                        <StatusBadge status="warning" label="Review required" />
                      ) : (
                        <StatusBadge status="healthy" label="No change" />
                      )}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        {row.active ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                              setExpanded(
                                expanded === row.active?.card.id ? null : row.active?.card.id ?? null,
                              )
                            }
                          >
                            View
                          </Button>
                        ) : null}
                        {row.provider !== "cursor" ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busyProvider === row.provider}
                            onClick={() => void requestReview(row.provider)}
                          >
                            <RefreshCw size={14} />
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  {expanded && row.active && expanded === row.active.card.id ? (
                    <tr key={`${row.provider}-detail`} className="expand-row">
                      <td colSpan={9}>
                        <details className="advanced-block" open>
                          <summary>Rate lines & technical details</summary>
                          {row.active.items.length === 0 ? (
                            <p className="muted small">No SKUs on this card yet.</p>
                          ) : (
                            <table className="table compact" style={{ marginTop: 8 }}>
                              <thead>
                                <tr>
                                  <th>Service</th>
                                  <th>Unit</th>
                                  <th className="num">Unit cost</th>
                                </tr>
                              </thead>
                              <tbody>
                                {row.active.items.map((item) => (
                                  <tr key={item.id}>
                                    <td>
                                      {item.service}
                                      {item.sku ? (
                                        <div className="mono small muted">{item.sku}</div>
                                      ) : null}
                                    </td>
                                    <td className="muted">{item.billingUnit}</td>
                                    <td className="num">
                                      {row.active?.card.status === "draft" ? (
                                        <input
                                          className="input"
                                          style={{ maxWidth: 120 }}
                                          type="number"
                                          step="0.000001"
                                          min="0"
                                          value={
                                            itemDrafts[row.active.card.id]?.[item.id] ??
                                            (item.unitCostMicros > 0
                                              ? String(item.unitCostMicros / 1_000_000)
                                              : "")
                                          }
                                          onChange={(e) =>
                                            setItemDrafts((prev) => ({
                                              ...prev,
                                              [row.active!.card.id]: {
                                                ...(prev[row.active!.card.id] ?? {}),
                                                [item.id]: e.target.value,
                                              },
                                            }))
                                          }
                                          placeholder="£ per unit"
                                        />
                                      ) : item.unitCostMicros > 0 ? (
                                        `£${(item.unitCostMicros / 1_000_000).toFixed(6)}`
                                      ) : (
                                        "Not configured"
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          <p className="mono small muted" style={{ marginTop: 8 }}>
                            Rate card ID: {row.active.card.versionLabel ?? row.active.card.id}
                          </p>
                          {row.active.card.status === "draft" ? (
                            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                              <Button
                                variant="secondary"
                                size="sm"
                                loading={busyProvider === row.active.card.id}
                                onClick={() => void saveDraftItems(row.active!.card.id, row.active!.items)}
                              >
                                Save unit costs
                              </Button>
                              <Button
                                variant="primary"
                                size="sm"
                                loading={busyProvider === row.active.card.id}
                                onClick={() => void approveCard(row.active!.card.id)}
                              >
                                Approve rate card
                              </Button>
                            </div>
                          ) : null}
                        </details>
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
        title="Proposed updates"
        description="Detected tariff changes stay pending until a Platform Administrator approves a new rate-card version."
        className="mt-6"
      >
        {reviews.length === 0 ? (
          <EmptyState
            icon={<Cloud size={28} />}
            title="No pending reviews"
            description="Use Check for updates to create a proposed rate-card review."
          />
        ) : (
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Detected</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((review) => (
                  <tr key={review.id}>
                    <td>{PROVIDER_META[review.provider]?.label ?? review.provider}</td>
                    <td>
                      <StatusBadge status={review.status} />
                    </td>
                    <td>{formatDate(review.detectedAt)}</td>
                    <td className="muted small">{review.sourceUrl ?? review.reviewNotes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  );
}
