import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  formatCurrency,
} from "../components";

export default function BillingPage() {
  const [rows, setRows] = useState<
    Awaited<ReturnType<typeof api.getBillingBalances>>
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setRows(await api.getBillingBalances());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load balances");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;

  return (
    <>
      <PageHeader
        title="Billing"
        subtitle="Company wallet balances across the platform. Stripe top-ups require configured secrets."
      />
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Balance</th>
              <th>Low balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.companyId}>
                <td>
                  <Link to={`/companies/${row.companySlug}`}>{row.companyName}</Link>
                </td>
                <td>{formatCurrency(row.balanceCents, row.currency)}</td>
                <td>{row.lowBalance ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
