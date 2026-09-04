import { useEffect, useState } from "react";
import { api } from "../api";
import { useAdminScope } from "../context/AdminScopeContext";
import {
  DataCard,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StatusBadge,
} from "../components";

export default function KnowledgeIntakePage() {
  const { companyId: scopeCompanyId } = useAdminScope();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getKnowledgeIntake>> | null>(null);

  async function load() {
    if (!scopeCompanyId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData(await api.getKnowledgeIntake({ companyId: scopeCompanyId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load knowledge intake");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [scopeCompanyId]);

  if (!scopeCompanyId) {
    return <EmptyState title="Select a company" description="Knowledge Intake is tenant-scoped. Choose a company in the admin switcher." />;
  }
  if (loading) return <LoadingState label="Loading knowledge intake…" />;
  if (error) return <ErrorState title="Unable to load knowledge intake" description={error} onRetry={() => void load()} />;

  const attachments = data?.attachments ?? [];
  const stored = attachments.filter((row) => row.stored).length;
  const indexed = attachments.filter((row) => row.indexed).length;
  const failed = attachments.filter((row) => row.failed).length;
  const duplicates = attachments.filter((row) => row.duplicate).length;

  return (
    <>
      <PageHeader
        title="Knowledge Intake"
        description="Email attachments stored in the company Microsoft 365 landing zone and their index status. Other tenants are never shown."
      />
      <div className="grid gap-4 md:grid-cols-4">
        <DataCard title="Recent attachments" metric={String(attachments.length)} />
        <DataCard title="Stored" metric={String(stored)} />
        <DataCard title="Indexed" metric={String(indexed)} />
        <DataCard title="Failed / retrying" metric={String(failed)} />
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Landing zone</h2>
        <p className="muted small">
          Status: {data?.target?.status ?? "unconfigured"}
          {data?.target?.root_folder_path ? ` · ${data.target.root_folder_path}` : ""}
          {data?.target?.last_error ? ` · ${data.target.last_error}` : ""}
        </p>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Approved mailboxes</h2>
        {(data?.mailboxes ?? []).length === 0 ? (
          <p className="muted">No mailbox registry rows for this company.</p>
        ) : (
          <ul>
            {(data?.mailboxes ?? []).map((mailbox) => (
              <li key={mailbox.address}>
                {mailbox.address} — ingest {mailbox.attachmentKnowledge ? "on" : "off"}, chat{" "}
                {mailbox.chatSearch ? "on" : "off"}
                {mailbox.lastError ? ` · ${mailbox.lastError}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Recent attachments</h2>
        {attachments.length === 0 ? (
          <p className="muted">No attachment ingestion events yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>File</th>
                <th>Mailbox</th>
                <th>Stored</th>
                <th>Indexed</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {attachments.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div>{row.filename ?? "unnamed"}</div>
                    {row.subject ? <div className="muted small">{String(row.subject)}</div> : null}
                  </td>
                  <td>{row.mailbox ?? "—"}</td>
                  <td>{row.stored ? "Yes" : "No"}</td>
                  <td>{row.indexed ? "Yes" : row.duplicate ? "Deduped" : "No"}</td>
                  <td>
                    <StatusBadge status={String(row.status)} />
                    {row.skipReason ? <div className="muted small">{row.skipReason}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {duplicates > 0 ? <p className="muted small">{duplicates} duplicate provenance links in this list.</p> : null}
      </div>
    </>
  );
}
