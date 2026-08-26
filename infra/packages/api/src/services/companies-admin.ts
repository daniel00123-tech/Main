import { getWalletBalance } from "./ledger";
import { listConnectorInstances, listMcpEnvironments } from "./control-plane";
import { listServiceIdentities } from "./service-identities";

export type CompanyAdminRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  primaryDomain: string | null;
  walletBalanceCents: number;
  walletLowBalance: boolean;
  usageThisMonth: number;
  usageFailedThisMonth: number;
  spendThisMonthCents: number;
  lastActivityAt: string | null;
  connectorCount: number;
  connectedConnectors: number;
  mcpStatus: string | null;
  aiIdentityCount: number;
  activeUserCount: number;
  needsAttention: boolean;
};

export async function listCompaniesAdminDirectory(db: D1Database): Promise<CompanyAdminRow[]> {
  const companies = await db
    .prepare(`SELECT id, name, slug, status, primary_domain, updated_at FROM companies ORDER BY name ASC`)
    .all();
  const [connectors, mcps, usageRows] = await Promise.all([
    listConnectorInstances(db),
    listMcpEnvironments(db),
    db
      .prepare(
        `SELECT company_id,
                COUNT(*) AS requests,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed,
                SUM(COALESCE(customer_charge_cents, 0)) AS spend_cents,
                MAX(recorded_at) AS last_at
         FROM usage_records
         WHERE recorded_at >= datetime('now', 'start of month')
         GROUP BY company_id`,
      )
      .all(),
  ]);

  const usageByCompany = new Map(
    (usageRows.results ?? []).map((row) => [
      String(row.company_id),
      {
        requests: Number(row.requests ?? 0),
        failed: Number(row.failed ?? 0),
        spendCents: Number(row.spend_cents ?? 0),
        lastAt: row.last_at ? String(row.last_at) : null,
      },
    ]),
  );

  const rows: CompanyAdminRow[] = [];
  for (const raw of companies.results ?? []) {
    const id = String(raw.id);
    const companyConnectors = connectors.filter((c) => c.companyId === id);
    const companyMcps = mcps.filter((m) => m.companyId === id);
    const wallet = await getWalletBalance(db, id);
    const identities = await listServiceIdentities(db, id);
    const membershipRow = await db
      .prepare(`SELECT COUNT(*) AS count FROM company_memberships WHERE company_id = ?`)
      .bind(id)
      .first();
    const usage = usageByCompany.get(id);
    const mcpStatus = companyMcps[0]?.status ?? null;
    const connectedConnectors = companyConnectors.filter(
      (c) => c.status === "connected" || c.authStatus === "connected",
    ).length;
    const needsAttention =
      wallet.lowBalance ||
      companyConnectors.some((c) => c.status === "error" || c.healthStatus === "degraded") ||
      companyMcps.some((m) => ["degraded", "unreachable"].includes(m.status)) ||
      String(raw.status) === "onboarding";

    rows.push({
      id,
      name: String(raw.name),
      slug: String(raw.slug),
      status: String(raw.status),
      primaryDomain: raw.primary_domain ? String(raw.primary_domain) : null,
      walletBalanceCents: wallet.balanceCents,
      walletLowBalance: wallet.lowBalance,
      usageThisMonth: usage?.requests ?? 0,
      usageFailedThisMonth: usage?.failed ?? 0,
      spendThisMonthCents: usage?.spendCents ?? 0,
      lastActivityAt: usage?.lastAt ?? (raw.updated_at ? String(raw.updated_at) : null),
      connectorCount: companyConnectors.length,
      connectedConnectors,
      mcpStatus,
      aiIdentityCount: identities.filter((i) => i.status === "active").length,
      activeUserCount: Number(membershipRow?.count ?? 0),
      needsAttention,
    });
  }
  return rows;
}
