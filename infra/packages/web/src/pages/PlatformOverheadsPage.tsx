import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  SectionCard,
  formatCurrency,
  toast,
} from "../components";

export default function PlatformOverheadsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.getPlatformOverheads>>["items"]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [form, setForm] = useState({
    provider: "",
    description: "",
    monthlyPounds: "",
    startDate: new Date().toISOString().slice(0, 10),
    endDate: "",
    category: "software",
  });
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getPlatformOverheads();
      setItems(result.items);
      setCategories(result.categories);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load overheads");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    const pounds = Number(form.monthlyPounds);
    if (!form.provider.trim() || !form.description.trim() || !Number.isFinite(pounds) || pounds < 0) {
      toast("Provider, description, and a monthly cost are required", "error");
      return;
    }
    setSaving(true);
    try {
      await api.createPlatformOverhead({
        provider: form.provider.trim(),
        description: form.description.trim(),
        monthlyCostCents: Math.round(pounds * 100),
        startDate: new Date(form.startDate).toISOString(),
        endDate: form.endDate ? new Date(form.endDate).toISOString() : null,
        category: form.category,
      });
      setForm({
        provider: "",
        description: "",
        monthlyPounds: "",
        startDate: new Date().toISOString().slice(0, 10),
        endDate: "",
        category: form.category,
      });
      toast("Overhead recorded");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to save overhead", "error");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Loading platform overheads…" />;
  if (error) return <ErrorState title="Unable to load overheads" description={error} onRetry={() => void load()} />;

  const monthly = items.reduce((sum, item) => sum + item.monthlyCostCents, 0);

  return (
    <>
      <PageHeader
        title="Platform Overheads"
        description="Fixed software and tooling costs. These are not allocated to customers in V1."
      />
      <Notice tone="info">
        Magnific, Cursor, and other development subscriptions belong here. Customer economics stay
        on the Economics page and are not mixed with these figures.
      </Notice>
      <SectionCard title={`Active monthly total · ${formatCurrency(monthly)}`}>
        {items.length === 0 ? (
          <EmptyState title="No overheads recorded" description="Add a fixed monthly cost below." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th>Monthly</th>
                  <th>Dates</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.provider}</td>
                    <td>{item.description}</td>
                    <td>{item.category}</td>
                    <td>{formatCurrency(item.monthlyCostCents, item.currency)}</td>
                    <td className="muted small">
                      {item.startDate.slice(0, 10)}
                      {item.endDate ? ` → ${item.endDate.slice(0, 10)}` : ""}
                    </td>
                    <td>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={async () => {
                          if (!window.confirm(`Remove ${item.provider}?`)) return;
                          await api.deletePlatformOverhead(item.id);
                          await load();
                        }}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
      <SectionCard title="Record overhead">
        <form className="form-grid" onSubmit={(event) => void onCreate(event)}>
          <label>
            Provider
            <input value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} required />
          </label>
          <label>
            Description
            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              required
            />
          </label>
          <label>
            Monthly cost (£)
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.monthlyPounds}
              onChange={(e) => setForm({ ...form, monthlyPounds: e.target.value })}
              required
            />
          </label>
          <label>
            Category
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {(categories.length ? categories : ["software", "development_tooling", "ai_subscription"]).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            Start date
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              required
            />
          </label>
          <label>
            End date
            <input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </label>
          <div>
            <Button type="submit" variant="primary" loading={saving}>
              Save overhead
            </Button>
          </div>
        </form>
      </SectionCard>
    </>
  );
}
