import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { api } from "../api";
import { Button, formatRelativeTime } from "../components";
import { usePortalCompany } from "./usePortalCompany";

type NotificationItem = {
  id: string;
  title: string;
  body: string;
  severity: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
};

export function PortalNotificationBell({ variant = "sidebar" }: { variant?: "header" | "sidebar" }) {
  const { company } = usePortalCompany();
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!company) return;
    try {
      const data = await api.getNotifications(company.slug);
      setItems(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch {
      /* non-blocking */
    }
  }, [company]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function markRead(id: string) {
    if (!company) return;
    await api.markNotificationRead(company.slug, id);
    await refresh();
  }

  async function markAllRead() {
    if (!company) return;
    await api.markAllNotificationsRead(company.slug);
    await refresh();
  }

  if (!company) return null;

  return (
    <div
      className={[
        "notification-bell",
        variant === "header" ? "notification-bell--header" : "notification-bell--sidebar",
      ].join(" ")}
      ref={panelRef}
    >
      <button
        type="button"
        className="button button-ghost button-small notification-bell-trigger"
        aria-label={`Notifications${unreadCount ? ` (${unreadCount} unread)` : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void refresh();
        }}
      >
        <Bell size={18} />
        {unreadCount > 0 ? (
          <span className="notification-badge" aria-hidden>
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="notification-panel" role="dialog" aria-label="Notifications">
          <div className="notification-panel-header">
            <strong>Notifications</strong>
            {unreadCount > 0 ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => void markAllRead()}>
                Mark all read
              </Button>
            ) : null}
          </div>
          {items.length === 0 ? (
            <p className="muted small notification-panel-empty">No notifications yet.</p>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`notification-item${item.readAt ? "" : " unread"}`}
                onClick={() => {
                  void markRead(item.id);
                  if (item.href) window.location.href = item.href;
                  setOpen(false);
                }}
              >
                <div className="notification-item-title">{item.title}</div>
                <div className="muted small">{item.body}</div>
                <div className="muted small">{formatRelativeTime(item.createdAt)}</div>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
