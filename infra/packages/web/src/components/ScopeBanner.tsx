import { useLocation } from "react-router-dom";
import { Building2, Globe2 } from "lucide-react";
import { useAdminScope } from "../context/AdminScopeContext";
import { getPageScopeMode, scopeModeLabel } from "../lib/admin-scope";

export default function ScopeBanner() {
  const { scope, scopeLabel, scopeSublabel } = useAdminScope();
  const { pathname } = useLocation();
  const pageMode = getPageScopeMode(pathname);

  const isPlatform = scope.mode === "platform";
  const Icon = isPlatform ? Globe2 : Building2;

  return (
    <div
      className={`scope-banner ${pageMode === "platform-only" ? "scope-banner-neutral" : ""}`}
      role="status"
      aria-live="polite"
    >
      <Icon size={16} aria-hidden />
      <div className="scope-banner-text">
        <strong>{scopeLabel}</strong>
        <span className="muted small">
          {pageMode === "platform-only"
            ? scopeModeLabel(pageMode)
            : isPlatform
              ? "Platform-wide data"
              : `${scopeSublabel} · tenant-scoped view`}
        </span>
      </div>
    </div>
  );
}
