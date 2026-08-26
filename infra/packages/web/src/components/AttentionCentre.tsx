import { Link } from "react-router-dom";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { Button } from "../components";

export type AttentionCentreItem = {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  companyName?: string | null;
  href?: string | null;
  recommendedAction?: string;
};

const SEVERITY_META = {
  critical: { label: "Critical", icon: AlertCircle, className: "attention-severity-critical" },
  warning: { label: "Action required", icon: AlertTriangle, className: "attention-severity-warning" },
  info: { label: "Info", icon: Info, className: "attention-severity-info" },
} as const;

export default function AttentionCentre({
  items,
  onDismiss,
  allClear = "No platform alerts",
}: {
  items: AttentionCentreItem[];
  onDismiss?: (item: AttentionCentreItem) => void;
  allClear?: string;
}) {
  if (items.length === 0) {
    return (
      <div className="attention-centre attention-centre-clear" role="status">
        <CheckCircle2 size={20} color="var(--success)" aria-hidden />
        <div>
          <p className="attention-title">{allClear}</p>
          <p className="muted small" style={{ margin: 0 }}>
            Nothing requires attention right now.
          </p>
        </div>
      </div>
    );
  }

  return (
    <section className="attention-centre" aria-label="Items requiring attention">
      <header className="attention-centre-header">
        <AlertTriangle size={18} aria-hidden />
        <div>
          <h2 className="attention-title" style={{ margin: 0 }}>
            {items.length} item{items.length === 1 ? "" : "s"} need review
          </h2>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            Critical issues cannot be dismissed until resolved.
          </p>
        </div>
      </header>
      <ul className="attention-centre-list">
        {items.map((item) => {
          const meta = SEVERITY_META[item.severity];
          const Icon = meta.icon;
          return (
            <li key={item.id} className={`attention-centre-item ${meta.className}`}>
              <div className="attention-centre-item-main">
                <span className="attention-severity-badge">
                  <Icon size={14} aria-hidden />
                  {meta.label}
                </span>
                <strong>{item.title}</strong>
                {item.companyName ? (
                  <span className="muted small">{item.companyName}</span>
                ) : null}
                <p className="small" style={{ margin: "6px 0 0" }}>
                  {item.detail}
                </p>
                {item.recommendedAction ? (
                  <p className="muted small" style={{ margin: "4px 0 0" }}>
                    Recommended: {item.recommendedAction}
                  </p>
                ) : null}
              </div>
              <div className="attention-centre-actions">
                {item.href ? (
                  <Link to={item.href} className="button button-small button-secondary">
                    Review
                  </Link>
                ) : null}
                {item.severity !== "critical" && onDismiss ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Dismiss ${item.title}`}
                    onClick={() => onDismiss(item)}
                  >
                    <X size={14} />
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
