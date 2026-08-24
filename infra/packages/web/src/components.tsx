import type { ReactNode } from "react";

export function StatusBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase().replaceAll("_", "-");
  return <span className={`badge badge-${normalized}`}>{value}</span>;
}

export function PageHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <>
      <h1 className="page-title">{title}</h1>
      {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
    </>
  );
}

export function LoadingState() {
  return <div className="card muted">Loading control plane data…</div>;
}

export function ErrorState({ message }: { message: string }) {
  return <div className="error-box">{message}</div>;
}

export function SectionCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="card stack">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function formatCurrency(cents: number, currency = "GBP") {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

export function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
