import { ClipboardList } from "lucide-react";
import { EmptyState, PageHeader, SectionCard } from "../components";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalActionsPage() {
  const { company } = usePortalCompany();

  return (
    <>
      <PageHeader
        title="Actions"
        description={`${company?.name ?? "Company"} · planned operations awaiting confirmation`}
      />

      <SectionCard
        title="Action plans"
        description="Financial and operational actions (Xero invoices, field-service jobs, appointments) appear here after an AI client creates a server-side plan. Nothing executes without your confirmation."
      >
        <EmptyState
          icon={<ClipboardList size={28} />}
          title="No action plans yet"
          description="When ChatGPT or another AI client plans a controlled write (accounting, scheduling, or field service), the plan is stored here for review — contact, amount, risk, and approval status — before anything runs in your business systems."
        />
      </SectionCard>
    </>
  );
}
