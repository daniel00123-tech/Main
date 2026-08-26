import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Info, X } from "lucide-react";
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

const COLLAPSED_KEY = "infra.admin.attentionCollapsed";

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export default function AttentionCentre({
  items,
  onDismiss,
  allClear = "No platform alerts",
}: {
  items: AttentionCentreItem[];
  onDismiss?: (item: AttentionCentreItem) => void;
  allClear?: string;
}) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  if (items.length === 0) {
    return (
      <div className="attention-centre attention-centre-clear attention-centre-compact" role="status">
        <CheckCircle2 size={18} color="var(--healthy)" aria-hidden />
        <div>
          <p className="attention-title">{allClear}</p>
        </div>
      </div>
    );
  }

  const criticalCount = items.filter((i) => i.severity === "critical").length;

  return (
    <section className="attention-centre attention-centre-compact" aria-label="Items requiring attention">
      <header className="attention-centre-header">
        <AlertTriangle size={16} aria-hidden />
        <div className="attention-centre-header-text">
          <h2 className="attention-title" style={{ margin: 0 }}>
            {items.length} item{items.length === 1 ? "" : "s"} need review
            {criticalCount > 0 ? ` · ${criticalCount} critical` : ""}
          </h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand attention items" : "Minimise attention items"}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          {collapsed ? "Show" : "Minimise"}
        </Button>
      </header>
      {!collapsed ? (
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
                  <p className="small" style={{ margin: "4px 0 0" }}>
                    {item.detail}
                  </p>
                  {item.recommendedAction ? (
                    <p className="muted small" style={{ margin: "2px 0 0" }}>
                      {item.recommendedAction}
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
      ) : null}
    </section>
  );
}
