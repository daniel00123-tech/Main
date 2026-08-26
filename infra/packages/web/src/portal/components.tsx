import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { PageHeader, StatusBadge } from "../components";

export function PortalPageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <PageHeader title={title} description={description} actions={actions} meta={meta} />
  );
}

export function IntegrationRow({
  icon,
  name,
  purpose,
  status,
  statusLabel,
  action,
  onClick,
}: {
  icon?: ReactNode;
  name: string;
  purpose: string;
  status: string;
  statusLabel?: string;
  action?: ReactNode;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <div className="integration-row-main">
        {icon ? <div className="integration-row-icon">{icon}</div> : null}
        <div className="integration-row-copy">
          <div className="integration-row-title">{name}</div>
          <div className="muted small">{purpose}</div>
        </div>
      </div>
      <div className="integration-row-meta">
        <StatusBadge status={status} label={statusLabel} />
        {action ?? (onClick ? <ChevronRight size={16} className="muted" aria-hidden /> : null)}
      </div>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className="integration-row" onClick={onClick}>
        {inner}
      </button>
    );
  }
  return <div className="integration-row">{inner}</div>;
}

export function CompactList({ children }: { children: ReactNode }) {
  return <div className="compact-list">{children}</div>;
}

export function ViewAllLink({ to, label = "View all" }: { to: string; label?: string }) {
  return (
    <Link to={to} className="view-all-link">
      {label}
      <ChevronRight size={14} aria-hidden />
    </Link>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ id: T; label: string; count?: number }>;
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="segmented-control" role="tablist" aria-label="Filter">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          role="tab"
          aria-selected={value === opt.id}
          className={`segmented-option${value === opt.id ? " active" : ""}`}
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
          {typeof opt.count === "number" ? ` (${opt.count})` : null}
        </button>
      ))}
    </div>
  );
}

export function ProductCard({
  name,
  benefit,
  price,
  status,
  action,
}: {
  name: string;
  benefit: string;
  price?: string;
  status: string;
  action?: ReactNode;
}) {
  return (
    <article className="product-card">
      <div className="product-card-header">
        <h4>{name}</h4>
        <StatusBadge status={status} />
      </div>
      <p className="muted small">{benefit}</p>
      {price ? <div className="product-card-price">{price}</div> : null}
      {action ? <div className="product-card-action">{action}</div> : null}
    </article>
  );
}
