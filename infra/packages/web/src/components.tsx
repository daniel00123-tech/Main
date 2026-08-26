import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2, Info, Search, X } from "lucide-react";
import {
  formatMoney,
  formatRelativeTime,
  formatShortDate,
  humanStatus,
  statusIcon,
  statusTone,
} from "./lib/format";

/* ─── Compat formatters (pages may import these) ─── */

export function formatCurrency(cents: number, currency = "GBP"): string {
  return formatMoney(cents, currency);
}

export function formatDate(iso: string | null | undefined): string {
  return formatShortDate(iso);
}

export type StatusTone = "success" | "warning" | "danger" | "info" | "muted";

/* ─── Layout ─── */

export function PageHeader({
  title,
  description,
  subtitle,
  breadcrumb,
  actions,
  meta,
}: {
  title: string;
  description?: string;
  /** @deprecated use description */
  subtitle?: string;
  breadcrumb?: Array<{ label: string; to?: string }>;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  const desc = description ?? subtitle;
  return (
    <header className="page-header">
      <div className="page-header-copy">
        {breadcrumb && breadcrumb.length > 0 ? (
          <nav className="page-breadcrumb" aria-label="Breadcrumb">
            {breadcrumb.map((crumb, i) => (
              <span key={`${crumb.label}-${i}`} style={{ display: "contents" }}>
                {i > 0 ? <span aria-hidden>/</span> : null}
                {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : <span aria-current="page">{crumb.label}</span>}
              </span>
            ))}
          </nav>
        ) : null}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h1 className="page-title">{title}</h1>
          {meta}
        </div>
        {desc ? <p className="page-subtitle">{desc}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`.trim()}>
      {(title || actions) && (
        <div className="card-header-row">
          <div>
            {title ? <h3 className="section-title">{title}</h3> : null}
            {description ? <p className="muted small" style={{ margin: "4px 0 0" }}>{description}</p> : null}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Section(props: Parameters<typeof SectionCard>[0]) {
  return <SectionCard {...props} />;
}

export function Card({
  children,
  className = "",
  elevated,
  style,
}: {
  children: ReactNode;
  className?: string;
  elevated?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div className={`card${elevated ? " card-elevated" : ""} ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  icon,
  to,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: ReactNode;
  to?: string;
}) {
  const inner = (
    <>
      {icon ? <span className="metric-icon">{icon}</span> : null}
      <h3 className="metric-label">{label}</h3>
      <div className="metric">{value}</div>
      {hint ? <p className="metric-foot">{hint}</p> : null}
    </>
  );
  if (to) {
    return (
      <Link to={to} className="card metric-card" style={{ textDecoration: "none", color: "inherit", display: "block" }}>
        {inner}
      </Link>
    );
  }
  return <div className="card metric-card">{inner}</div>;
}

export function MetricGrid({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  return <div className={`grid grid-${cols}`}>{children}</div>;
}

export function KpiStrip({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; hint?: string }>;
}) {
  return (
    <div className="kpi-strip" role="group" aria-label="Key metrics">
      {items.map((item) => (
        <div key={item.label} className="kpi-item">
          <div className="kpi-item-label">{item.label}</div>
          <div className="kpi-item-value">{item.value}</div>
          {item.hint ? <div className="kpi-item-hint">{item.hint}</div> : null}
        </div>
      ))}
    </div>
  );
}

/* ─── Status ─── */

export function StatusBadge({
  status,
  value,
  label,
}: {
  status?: string;
  /** @deprecated use status */
  value?: string;
  label?: string;
}) {
  const raw = status ?? value ?? "unknown";
  const tone = statusTone(raw);
  const icon = statusIcon(tone);
  return (
    <span className={`badge badge-${tone}`}>
      <span className="badge-icon" aria-hidden>
        {icon}
      </span>
      {label ?? humanStatus(raw)}
    </span>
  );
}

export function HealthIndicator({
  status,
  label,
}: {
  status: string;
  label?: string;
}) {
  return <StatusBadge status={status} label={label} />;
}

/* ─── Buttons & forms ─── */

export function Button({
  children,
  variant = "secondary",
  size = "md",
  loading,
  danger,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
  danger?: boolean;
}) {
  const v = danger ? "danger" : variant;
  return (
    <button
      className={`button button-${v}${size === "sm" ? " button-small" : ""} ${className}`.trim()}
      disabled={props.disabled || loading}
      {...props}
    >
      {loading ? "Working…" : children}
    </button>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={`search-field ${className}`.trim()}>
      <Search size={16} aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <label htmlFor={htmlFor}>
      {label}
      {children}
      {hint && !error ? <span className="muted small">{hint}</span> : null}
      {error ? <span className="error-text small">{error}</span> : null}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} />;
}

/* ─── Filters & tabs ─── */

export function FilterBar({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`filter-bar ${className}`.trim()}>{children}</div>;
}

export function FilterChip({
  active,
  children,
  onClick,
  count,
}: {
  active?: boolean;
  children: ReactNode;
  onClick?: () => void;
  count?: number;
}) {
  return (
    <button type="button" className={`chip${active ? " active" : ""}`} onClick={onClick} aria-pressed={active}>
      {children}
      {typeof count === "number" ? ` (${count})` : null}
    </button>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: string; label: string; count?: number }>;
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          className={`tab${active === t.id ? " active" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {typeof t.count === "number" ? ` (${t.count})` : null}
        </button>
      ))}
    </div>
  );
}

/* ─── Feedback ─── */

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading-state" aria-busy="true">
      <div className="stack" style={{ maxWidth: 360, margin: "0 auto", gap: 12 }}>
        <div className="skeleton" style={{ height: 28, width: "60%", margin: "0 auto" }} />
        <div className="skeleton" style={{ height: 14, width: "90%", margin: "0 auto" }} />
        <div className="skeleton" style={{ height: 14, width: "75%", margin: "0 auto" }} />
        <div className="skeleton" style={{ height: 72, marginTop: 8 }} />
      </div>
      <p style={{ marginTop: 16 }}>{label}</p>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon ? <div style={{ marginBottom: 12, color: "var(--text-muted)" }}>{icon}</div> : null}
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action ? <div className="empty-actions">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  description,
  message,
  onRetry,
}: {
  title?: string;
  description?: string;
  /** @deprecated use description */
  message?: string;
  onRetry?: () => void;
}) {
  const desc = description ?? message;
  return (
    <div className="error-state">
      <AlertCircle size={22} aria-hidden style={{ color: "var(--danger)", marginBottom: 8 }} />
      <h3>{title}</h3>
      {desc ? <p>{desc}</p> : null}
      {onRetry ? (
        <div className="empty-actions">
          <Button type="button" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function AttentionBanner({
  items,
  allClear = "All systems operational",
}: {
  items: Array<{ id: string; title: string; description?: string; to?: string }>;
  allClear?: string;
}) {
  if (items.length === 0) {
    return (
      <div className="attention-banner ok" role="status">
        <CheckCircle2 size={18} color="var(--success)" aria-hidden />
        <div>
          <p className="attention-title">{allClear}</p>
          <p>Nothing requires attention right now.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="attention-banner warn" role="status">
      <AlertCircle size={18} color="var(--warning)" aria-hidden />
      <div>
        <p className="attention-title">
          {items.length} item{items.length === 1 ? "" : "s"} require{items.length === 1 ? "s" : ""} attention
        </p>
        <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          {items.map((item) => (
            <li key={item.id} style={{ marginBottom: 4 }}>
              {item.to ? <Link to={item.to}>{item.title}</Link> : <span>{item.title}</span>}
              {item.description ? <span className="muted"> — {item.description}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function Skeleton({ height = 16, width = "100%" }: { height?: number | string; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden />;
}

export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "success" | "warning" | "danger";
}) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "warning" || tone === "danger" ? AlertCircle : Info;
  const cls =
    tone === "danger" ? "error-box" : tone === "warning" ? "attention-banner warn" : tone === "success" ? "attention-banner ok" : "info-banner";
  return (
    <div className={cls} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <Icon size={16} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
      <div>{children}</div>
    </div>
  );
}

/* ─── Modal & Drawer ─── */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
          <div>
            <h2 id={titleId} style={{ margin: 0, fontSize: "var(--text-xl)" }}>
              {title}
            </h2>
            {description ? <p className="muted small" style={{ margin: "6px 0 0" }}>{description}</p> : null}
          </div>
          <button type="button" className="button button-ghost button-small" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div>{children}</div>
        {footer ? (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} role="presentation" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="button button-ghost button-small" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
        {footer ? <div style={{ marginTop: 20 }}>{footer}</div> : null}
      </aside>
    </>
  );
}

/* ─── Toast ─── */

type ToastItem = { id: string; message: string; tone: "success" | "error" | "info" };

let toastPush: ((t: Omit<ToastItem, "id">) => void) | null = null;

export function toast(message: string, tone: ToastItem["tone"] = "success") {
  toastPush?.({ message, tone });
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    toastPush = (t) => {
      const id = crypto.randomUUID();
      setItems((prev) => [...prev, { ...t, id }]);
      window.setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), 4200);
    };
    return () => {
      toastPush = null;
    };
  }, []);

  if (items.length === 0) {
    return <div className="toast-stack" aria-live="polite" />;
  }
  return (
    <div className="toast-stack" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {t.tone === "success" ? (
            <CheckCircle2 size={16} color="var(--success)" />
          ) : t.tone === "error" ? (
            <AlertCircle size={16} color="var(--danger)" />
          ) : (
            <Info size={16} color="var(--info)" />
          )}
          {t.message}
        </div>
      ))}
    </div>
  );
}

/* ─── Data table ─── */

export function DataTable({
  columns,
  rows,
  empty,
  onRowClick,
}: {
  columns: Array<{
    key: string;
    header: string;
    align?: "left" | "right";
    width?: string;
    render: (row: Record<string, unknown>) => ReactNode;
  }>;
  rows: Array<Record<string, unknown> & { id: string }>;
  empty?: ReactNode;
  onRowClick?: (row: Record<string, unknown>) => void;
}) {
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="No results" description="Nothing matches the current filters." />}</>;
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.align === "right" ? "num" : undefined} style={{ width: c.width }}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={onRowClick ? { cursor: "pointer" } : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((c) => (
                <td key={c.key} className={c.align === "right" ? "num" : undefined}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Activity ─── */

export function ActivityFeed({
  items,
}: {
  items: Array<{
    id: string;
    title: string;
    description?: string;
    meta?: string;
    status?: string;
    onClick?: () => void;
  }>;
}) {
  if (items.length === 0) {
    return <EmptyState title="No recent activity" description="Events will appear here as they happen." />;
  }
  return (
    <div className="stack" style={{ gap: 0 }}>
      {items.map((item) => (
        <div
          key={item.id}
          className="drawer-row"
          style={{
            gridTemplateColumns: "1fr auto",
            cursor: item.onClick ? "pointer" : undefined,
            alignItems: "start",
          }}
          onClick={item.onClick}
          role={item.onClick ? "button" : undefined}
          tabIndex={item.onClick ? 0 : undefined}
          onKeyDown={
            item.onClick
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    item.onClick?.();
                  }
                }
              : undefined
          }
        >
          <div>
            <div style={{ fontWeight: 560 }}>{item.title}</div>
            {item.description ? <div className="muted small">{item.description}</div> : null}
          </div>
          <div style={{ textAlign: "right", display: "grid", gap: 6, justifyItems: "end" }}>
            {item.status ? <StatusBadge status={item.status} /> : null}
            {item.meta ? <span className="muted small">{item.meta}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AdvancedDetails({ children, label = "Advanced" }: { children: ReactNode; label?: string }) {
  return (
    <details className="advanced-block">
      <summary>{label}</summary>
      <div className="stack" style={{ marginTop: 12, gap: 8 }}>
        {children}
      </div>
    </details>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

export function KeyValue({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="drawer-row">
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{value}</dd>
    </div>
  );
}

export function ConfirmDangerModal({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  loading?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="muted small" style={{ margin: 0 }}>
        Existing history and audit records will remain.
      </p>
    </Modal>
  );
}

/* ─── Hooks ─── */

export function useSidebarCollapsed(key = "infra.sidebar.collapsed") {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [collapsed, key]);
  return [collapsed, setCollapsed] as const;
}

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = () => setMatches(mq.matches);
    fn();
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [query]);
  return matches;
}

export function useIsMobile() {
  return useMediaQuery("(max-width: 768px)");
}

export function ShowMoreFooter({
  shown,
  total,
  onShowMore,
  step = 20,
}: {
  shown: number;
  total: number;
  onShowMore: () => void;
  step?: number;
}) {
  if (shown >= total) return null;
  return (
    <div className="show-more-footer">
      <Button type="button" variant="secondary" size="sm" onClick={onShowMore}>
        Show more ({Math.min(step, total - shown)} of {total - shown} remaining)
      </Button>
    </div>
  );
}

export function MobileRecordList({ children }: { children: ReactNode }) {
  return <div className="mobile-record-list">{children}</div>;
}

export function MobileRecordCard({
  children,
  onClick,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const Tag = onClick ? "button" : "article";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      className={`mobile-record-card ${className}`.trim()}
      onClick={onClick}
    >
      {children}
    </Tag>
  );
}

export function CollapsibleBlock({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="collapsible-block"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>
        <span>{title}</span>
        {summary ? <span className="collapsible-summary">{summary}</span> : null}
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}

export function useClickOutside(ref: React.RefObject<HTMLElement | null>, onOutside: () => void) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ref, onOutside]);
}

export function ActionMenu({
  items,
}: {
  items: Array<{ label: string; onClick: () => void; danger?: boolean; disabled?: boolean }>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false));
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <Button type="button" variant="ghost" size="sm" aria-label="Actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        •••
      </Button>
      {open ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: "110%",
            minWidth: 160,
            background: "var(--surface-2)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--r-md)",
            boxShadow: "var(--shadow-md)",
            zIndex: 20,
            padding: 4,
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="button button-ghost"
              disabled={item.disabled}
              style={{
                width: "100%",
                justifyContent: "flex-start",
                color: item.danger ? "var(--danger)" : undefined,
                border: "none",
              }}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export { formatRelativeTime, humanStatus, statusTone };
