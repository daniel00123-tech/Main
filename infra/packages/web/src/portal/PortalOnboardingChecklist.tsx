import { Link } from "react-router-dom";
import { Circle } from "lucide-react";
import { Notice, SectionCard } from "../components";
import { usePortalCompany } from "./usePortalCompany";

const CHECKLIST = [
  { key: "profile", label: "Complete company profile", path: "settings" },
  { key: "payment", label: "Add payment method", path: "billing?tab=payment" },
  { key: "auto-topup", label: "Configure wallet settings", path: "billing?tab=auto-topup" },
  { key: "connector", label: "Connect first system", path: "connectors" },
  { key: "ai", label: "Connect ChatGPT or Claude", path: "ai-connections" },
  { key: "team", label: "Invite team members", path: "users" },
  { key: "usage", label: "Run first successful request", path: "usage" },
];

export function PortalOnboardingChecklist() {
  const { company, membership } = usePortalCompany();
  const canManage =
    membership?.role === "company_admin" || membership?.role === "director";

  if (!company || !canManage) return null;

  const dismissed = localStorage.getItem(`infra.onboarding.dismissed.${company.id}`);
  if (dismissed === "1") return null;

  return (
    <SectionCard title="Getting started">
      <Notice tone="info">
        Complete these steps to get the most from INFRA. Optional steps can be done later.
      </Notice>
      <ul style={{ listStyle: "none", padding: 0, margin: "16px 0 0" }}>
        {CHECKLIST.map((item) => (
          <li key={item.key} style={{ marginBottom: 8 }}>
            <Link
              to={`/portal/${company.slug}/${item.path}`}
              style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }}
            >
              <Circle size={16} className="muted" />
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="button button-ghost button-small"
        style={{ marginTop: 12 }}
        onClick={() => localStorage.setItem(`infra.onboarding.dismissed.${company.id}`, "1")}
      >
        Dismiss checklist
      </button>
    </SectionCard>
  );
}
