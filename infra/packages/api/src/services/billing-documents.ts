import { newId, nowIso } from "../db/mappers";

export type BillingDocument = {
  id: string;
  companyId: string;
  documentType: string;
  externalRef: string | null;
  invoiceNumber: string | null;
  issueDate: string | null;
  amountCents: number | null;
  currency: string;
  status: string;
  periodStart: string | null;
  periodEnd: string | null;
  pdfUrl: string | null;
  createdAt: string;
};

export async function listBillingDocuments(
  db: D1Database,
  companyId: string,
): Promise<BillingDocument[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM billing_documents
       WHERE company_id = ?
       ORDER BY issue_date DESC NULLS LAST, created_at DESC
       LIMIT 100`,
    )
    .bind(companyId)
    .all();

  return (rows.results ?? []).map(mapRow);
}

export async function upsertBillingDocument(
  db: D1Database,
  input: {
    companyId: string;
    documentType?: string;
    externalRef?: string;
    invoiceNumber?: string;
    issueDate?: string;
    amountCents?: number;
    status?: string;
    periodStart?: string;
    periodEnd?: string;
    pdfUrl?: string;
  },
): Promise<BillingDocument> {
  const id = newId("bdoc");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO billing_documents (
        id, company_id, document_type, external_ref, invoice_number,
        issue_date, amount_cents, currency, status, period_start, period_end,
        pdf_url, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'GBP', ?, ?, ?, ?, '{}', ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.documentType ?? "xero_invoice",
      input.externalRef ?? null,
      input.invoiceNumber ?? null,
      input.issueDate ?? null,
      input.amountCents ?? null,
      input.status ?? "draft",
      input.periodStart ?? null,
      input.periodEnd ?? null,
      input.pdfUrl ?? null,
      now,
      now,
    )
    .run();

  const row = await db.prepare(`SELECT * FROM billing_documents WHERE id = ?`).bind(id).first();
  return mapRow(row!);
}

function mapRow(row: Record<string, unknown>): BillingDocument {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    documentType: String(row.document_type),
    externalRef: row.external_ref ? String(row.external_ref) : null,
    invoiceNumber: row.invoice_number ? String(row.invoice_number) : null,
    issueDate: row.issue_date ? String(row.issue_date) : null,
    amountCents: row.amount_cents != null ? Number(row.amount_cents) : null,
    currency: String(row.currency ?? "GBP"),
    status: String(row.status),
    periodStart: row.period_start ? String(row.period_start) : null,
    periodEnd: row.period_end ? String(row.period_end) : null,
    pdfUrl: row.pdf_url ? String(row.pdf_url) : null,
    createdAt: String(row.created_at),
  };
}
