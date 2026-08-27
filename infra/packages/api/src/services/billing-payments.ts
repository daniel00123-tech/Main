import { listLedgerEntries } from "./ledger";

export type BillingPaymentRecord = {
  id: string;
  date: string;
  amountCents: number;
  entryType: string;
  creditClass: string | null;
  status: string;
  stripePaymentIntentId: string | null;
  stripeCheckoutSessionId: string | null;
  stripeEventId: string | null;
  description: string | null;
  referenceType: string | null;
  receiptUrl: string | null;
};

/** List wallet payment-related ledger entries for billing documents UI. */
export async function listBillingPayments(
  db: D1Database,
  companyId: string,
): Promise<BillingPaymentRecord[]> {
  const entries = await listLedgerEntries(db, companyId, 200);
  return entries
    .filter((e) =>
      ["top_up", "manual_credit", "promotional_credit", "adjustment", "refund"].includes(
        e.entryType,
      ),
    )
    .map((e) => {
      const meta = e.metadata ?? {};
      const piId = meta.stripePaymentIntentId ? String(meta.stripePaymentIntentId) : null;
      return {
        id: e.id,
        date: e.createdAt,
        amountCents: e.amountCents,
        entryType: e.entryType,
        creditClass:
          meta.creditClass === "paid" || meta.creditClass === "test"
            ? String(meta.creditClass)
            : e.entryType === "promotional_credit"
              ? "test"
              : e.entryType === "top_up"
                ? "paid"
                : null,
        status: "completed",
        stripePaymentIntentId: piId,
        stripeCheckoutSessionId: meta.stripeCheckoutSessionId
          ? String(meta.stripeCheckoutSessionId)
          : null,
        stripeEventId: meta.stripeEventId ? String(meta.stripeEventId) : null,
        description: e.description,
        referenceType: e.referenceType,
        receiptUrl: piId ? `https://dashboard.stripe.com/test/payments/${piId}` : null,
      };
    });
}
