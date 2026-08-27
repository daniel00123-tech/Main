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

export function PortalNotificationBell() {
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
    function onClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
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
    <div className="notification-bell" ref={panelRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="button button-ghost button-small"
        aria-label={`Notifications${unreadCount ? ` (${unreadCount} unread)` : ""}`}
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void refresh();
        }}
      >
        <Bell size={18} />
        {unreadCount > 0 ? (
          <span
            className="notification-badge"
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              background: "var(--danger)",
              color: "#fff",
              borderRadius: 999,
              fontSize: 10,
              minWidth: 16,
              height: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 4px",
            }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className="notification-panel"
          style={{
            position: "absolute",
            right: 0,
            top: "100%",
            marginTop: 8,
            width: 320,
            maxHeight: 400,
            overflow: "auto",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            zIndex: 100,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "12px 16px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <strong>Notifications</strong>
            {unreadCount > 0 ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => void markAllRead()}>
                Mark all read
              </Button>
            ) : null}
          </div>
          {items.length === 0 ? (
            <p className="muted small" style={{ padding: 16 }}>
              No notifications yet.
            </p>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="notification-item"
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "12px 16px",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  background: item.readAt ? "transparent" : "var(--surface-muted)",
                  cursor: "pointer",
                }}
                onClick={() => {
                  void markRead(item.id);
                  if (item.href) window.location.href = item.href;
                  setOpen(false);
                }}
              >
                <div style={{ fontWeight: item.readAt ? 400 : 600 }}>{item.title}</div>
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
