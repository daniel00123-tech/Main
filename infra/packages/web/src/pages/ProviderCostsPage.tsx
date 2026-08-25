import { useEffect, useState } from "react";
import { Cloud, RefreshCw } from "lucide-react";
import { api } from "../api";
import {
  Button,
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingState,
  Notice,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatDate,
  toast,
} from "../components";

type ProviderCard = Awaited<ReturnType<typeof api.getProviderCosts>>["cards"][number];

const PROVIDER_LABELS: Record<string, string> = {
  cloudflare: "Cloudflare",
  openai: "OpenAI",
  anthropic: "Anthropic",
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
      toast(`Pricing review proposed for ${PROVIDER_LABELS[provider] ?? provider}`);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Review request failed", "error");
    } finally {
      setBusyProvider(null);
    }
  }

  if (loading) return <LoadingState label="Loading provider costs…" />;
  if (error) {
    return (
      <ErrorState title="Unable to load provider costs" description={error} onRetry={() => void load()} />
    );
  }

  const byProvider = new Map<string, ProviderCard[]>();
  for (const entry of cards) {
    const list = byProvider.get(entry.card.provider) ?? [];
    list.push(entry);
    byProvider.set(entry.card.provider, list);
  }

  return (
    <>
      <PageHeader
        title="Provider costs"
        description="Versioned rate cards for underlying infrastructure INFRA may consume in production transactions. Cursor development overhead is excluded."
      />

      {note ? <Notice tone="info">{note}</Notice> : null}

      <div className="connector-grid" style={{ marginTop: 16 }}>
        {(["cloudflare", "openai", "anthropic"] as const).map((provider) => {
          const entries = byProvider.get(provider) ?? [];
          const active =
            entries.find((e) => e.card.status === "active") ??
            entries.find((e) => e.card.status === "draft") ??
            entries[0];
          const lastReview = active?.card.verifiedAt ?? active?.card.updatedAt ?? null;
          return (
            <article key={provider} className="connector-card" style={{ minHeight: 220 }}>
              <div className="connection-header">
                <h3 style={{ margin: 0 }}>{PROVIDER_LABELS[provider] ?? provider}</h3>
                <StatusBadge status={active?.card.status ?? "draft"} />
              </div>
              <KeyValue
                label="Last pricing review"
                value={lastReview ? formatDate(lastReview) : "Not verified"}
              />
              <KeyValue
                label="Next scheduled review"
                value={formatDate(nextReviewDate(lastReview))}
              />
              <KeyValue
                label="Rate card"
                value={active?.card.versionLabel ?? "—"}
                mono
              />
              <p className="muted small" style={{ marginTop: 8 }}>
                {active?.items.some((i) => i.unitCostMicros > 0)
                  ? `${active.items.length} configured rate line(s)`
                  : "Underlying unit costs: unavailable / not configured"}
              </p>
              <div className="connector-card-actions">
                <Button
                  variant="secondary"
                  disabled={!active}
                  onClick={() => setExpanded(expanded === active?.card.id ? null : active?.card.id ?? null)}
                >
                  View rates
                </Button>
                <Button
                  variant="secondary"
                  disabled={busyProvider === provider}
                  onClick={() => void requestReview(provider)}
                >
                  <RefreshCw size={14} /> Check for updates
                </Button>
              </div>
              {expanded && active && expanded === active.card.id ? (
                <div style={{ marginTop: 12 }}>
                  {active.items.length === 0 ? (
                    <p className="muted small">No SKUs on this card yet.</p>
                  ) : (
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Service</th>
                          <th>Unit</th>
                          <th className="num">Unit cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {active.items.map((item) => (
                          <tr key={item.id}>
                            <td>
                              {item.service}
                              {item.sku ? (
                                <div className="muted small mono">{item.sku}</div>
                              ) : null}
                            </td>
                            <td className="muted">{item.billingUnit}</td>
                            <td className="num">
                              {item.unitCostMicros > 0
                                ? `£${(item.unitCostMicros / 1_000_000).toFixed(6)}`
                                : "Not configured"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      <SectionCard
        title="Proposed updates"
        description="Scraped or imported tariffs stay pending until a Platform Administrator approves a new rate-card version."
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
            <table className="table">
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
                    <td>{PROVIDER_LABELS[review.provider] ?? review.provider}</td>
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
