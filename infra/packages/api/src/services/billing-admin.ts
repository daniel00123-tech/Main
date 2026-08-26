import type { LedgerEntry } from "./ledger";
import { classifyLedgerCredit, creditClassForEntry } from "./wallet-credits";
import { listLedgerEntries, listPlatformBalances } from "./ledger";

export type EnrichedBalanceRow = Awaited<
  ReturnType<typeof listPlatformBalances>
>[number] & {
  paidCreditCents: number;
  promotionalCreditCents: number;
  spendThisMonthCents: number;
  creditsAddedThisMonthCents: number;
};

export async function listEnrichedPlatformBalances(
  db: D1Database,
): Promise<EnrichedBalanceRow[]> {
  const balances = await listPlatformBalances(db);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthStartIso = monthStart.toISOString();

  const rows: EnrichedBalanceRow[] = [];
  for (const row of balances) {
    const ledger = await listLedgerEntries(db, row.companyId, 500);
    const credits = classifyLedgerCredit(ledger);
    const spendThisMonthCents = ledger
      .filter(
        (e) =>
          e.entryType === "usage_debit" &&
          e.createdAt >= monthStartIso &&
          e.amountCents < 0,
      )
      .reduce((sum, e) => sum + Math.abs(e.amountCents), 0);
    const creditsAddedThisMonthCents = ledger
      .filter((e) => e.amountCents > 0 && e.createdAt >= monthStartIso)
      .reduce((sum, e) => sum + e.amountCents, 0);

    rows.push({
      ...row,
      paidCreditCents: credits.paidCents,
      promotionalCreditCents: credits.testCents,
      spendThisMonthCents,
      creditsAddedThisMonthCents,
    });
  }
  return rows;
}

export type PlatformLedgerRow = LedgerEntry & {
  companyName: string;
  companySlug: string;
  creditClass: "paid" | "promotional" | null;
  sourceLabel: string;
};

function ledgerSourceLabel(entry: LedgerEntry): string {
  const meta = entry.metadata ?? {};
  if (entry.entryType === "top_up") return "Stripe";
  if (entry.createdBy?.includes("stripe")) return "Stripe";
  if (entry.referenceType === "manual") {
    return entry.createdBy?.includes("@") ? entry.createdBy : "Platform admin";
  }

  const client =
    typeof meta.sourceClient === "string" ? meta.sourceClient : null;
  const userEmail = entry.createdBy?.includes("@") ? entry.createdBy : null;

  if (userEmail && client) {
    const clientLabel =
      client === "chatgpt"
        ? "ChatGPT"
        : client === "claude"
          ? "Claude"
          : client;
    return `${formatEmailName(userEmail)} via ${clientLabel}`;
  }
  if (userEmail) return formatEmailName(userEmail);
  if (client) {
    if (client === "chatgpt") return "ChatGPT";
    if (client === "claude") return "Claude";
    return client;
  }
  if (entry.createdBy) return entry.createdBy;
  return "System";
}

function formatEmailName(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function listPlatformLedger(
  db: D1Database,
  filters?: {
    companyId?: string;
    from?: string;
    to?: string;
    entryType?: string;
    creditClass?: "paid" | "promotional";
    q?: string;
    limit?: number;
  },
): Promise<PlatformLedgerRow[]> {
  const limit = Math.min(filters?.limit ?? 200, 5000);
  const companies = await db
    .prepare(`SELECT id, name, slug FROM companies ORDER BY name ASC`)
    .all();
  const companyById = new Map(
    (companies.results ?? []).map((c) => [
      String(c.id),
      { name: String(c.name), slug: String(c.slug) },
    ]),
  );

  let query = `SELECT le.* FROM ledger_entries le`;
  const binds: unknown[] = [];
  const where: string[] = [];

  if (filters?.companyId) {
    where.push("le.company_id = ?");
    binds.push(filters.companyId);
  }
  if (filters?.from) {
    where.push("le.created_at >= ?");
    binds.push(filters.from);
  }
  if (filters?.to) {
    where.push("le.created_at <= ?");
    binds.push(filters.to);
  }
  if (filters?.entryType) {
    where.push("le.entry_type = ?");
    binds.push(filters.entryType);
  }
  if (where.length) query += ` WHERE ${where.join(" AND ")}`;
  query += ` ORDER BY le.created_at DESC LIMIT ?`;
  binds.push(limit);

  const result = await db
    .prepare(query)
    .bind(...binds)
    .all();

  const rows: PlatformLedgerRow[] = [];
  for (const raw of result.results ?? []) {
    const entry: LedgerEntry = {
      id: String(raw.id),
      companyId: String(raw.company_id),
      entryType: String(raw.entry_type) as LedgerEntry["entryType"],
      amountCents: Number(raw.amount_cents),
      currency: String(raw.currency),
      balanceAfterCents: Number(raw.balance_after_cents),
      referenceType: raw.reference_type ? String(raw.reference_type) : null,
      referenceId: raw.reference_id ? String(raw.reference_id) : null,
      description: raw.description ? String(raw.description) : null,
      metadata: (() => {
        try {
          return JSON.parse(String(raw.metadata_json ?? "{}")) as Record<string, unknown>;
        } catch {
          return {};
        }
      })(),
      createdBy: raw.created_by ? String(raw.created_by) : null,
      createdAt: String(raw.created_at),
    };
    const cls = creditClassForEntry(entry);
    const creditClass =
      cls === "paid" ? "paid" : cls === "test" ? "promotional" : null;
    if (filters?.creditClass && creditClass !== filters.creditClass) continue;
    const co = companyById.get(entry.companyId);
    const sourceLabel = ledgerSourceLabel(entry);
    if (filters?.q) {
      const q = filters.q.toLowerCase();
      const haystack = [
        entry.description,
        entry.entryType,
        sourceLabel,
        co?.name,
        co?.slug,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) continue;
    }
    rows.push({
      ...entry,
      companyName: co?.name ?? entry.companyId,
      companySlug: co?.slug ?? "",
      creditClass,
      sourceLabel,
    });
  }
  return rows;
}

export function platformLedgerToCsv(rows: PlatformLedgerRow[]): string {
  const header = [
    "Timestamp",
    "Company",
    "User/Source",
    "Type",
    "Description",
    "Paid/Promotional",
    "Debit",
    "Credit",
    "Balance after",
    "Reference ID",
    "Correlation ID",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    const debit = row.amountCents < 0 ? (Math.abs(row.amountCents) / 100).toFixed(2) : "";
    const credit = row.amountCents > 0 ? (row.amountCents / 100).toFixed(2) : "";
    lines.push(
      [
        row.createdAt,
        csvEscape(row.companyName),
        csvEscape(row.sourceLabel),
        row.entryType,
        csvEscape(row.description ?? ""),
        row.creditClass ?? "",
        debit,
        credit,
        (row.balanceAfterCents / 100).toFixed(2),
        row.referenceId ?? "",
        String(row.metadata?.correlationId ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n");
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export async function getBillingPlatformSummary(db: D1Database) {
  const balances = await listEnrichedPlatformBalances(db);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthStartIso = monthStart.toISOString();

  return {
    companyCount: balances.length,
    totalWalletCents: balances.reduce((s, b) => s + b.balanceCents, 0),
    totalPaidCreditCents: balances.reduce((s, b) => s + b.paidCreditCents, 0),
    totalPromotionalCreditCents: balances.reduce(
      (s, b) => s + b.promotionalCreditCents,
      0,
    ),
    spendThisMonthCents: balances.reduce((s, b) => s + b.spendThisMonthCents, 0),
    creditsAddedThisMonthCents: balances.reduce(
      (s, b) => s + b.creditsAddedThisMonthCents,
      0,
    ),
    lowBalanceCount: balances.filter((b) => b.lowBalance).length,
    monthStart: monthStartIso,
  };
}
