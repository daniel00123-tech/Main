import { listLedgerEntries } from "./ledger";

export type BillingPaymentRecord = {
  id: string;
  date: string;
  amountCents: number;
  entryType: string;
  creditClass: string | null;
  stripeMode: "live" | "test" | null;
  status: string;
  stripePaymentIntentId: string | null;
  stripeCheckoutSessionId: string | null;
  stripeEventId: string | null;
  description: string | null;
  referenceType: string | null;
  receiptUrl: string | null;
};

function inferStripeMode(meta: Record<string, unknown>): "live" | "test" | null {
  const mode = meta.stripeMode ? String(meta.stripeMode) : null;
  if (mode === "live" || mode === "test") return mode;
  const sessionId = meta.stripeSessionId ? String(meta.stripeSessionId) : null;
  if (sessionId?.startsWith("cs_live_")) return "live";
  if (sessionId?.startsWith("cs_test_")) return "test";
  const piId = meta.stripePaymentIntentId ? String(meta.stripePaymentIntentId) : null;
  if (piId?.includes("_live_") || piId?.match(/^pi_[^_]*live/)) return "live";
  return null;
}

function receiptUrlForPayment(
  paymentIntentId: string | null,
  stripeMode: "live" | "test" | null,
): string | null {
  if (!paymentIntentId) return null;
  const base =
    stripeMode === "live"
      ? "https://dashboard.stripe.com/payments/"
      : "https://dashboard.stripe.com/test/payments/";
  return `${base}${paymentIntentId}`;
}

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
      const stripeMode = inferStripeMode(meta);
      const creditClass =
        stripeMode === "test" && e.entryType === "top_up"
          ? "test"
          : meta.creditClass === "paid" || meta.creditClass === "test"
            ? String(meta.creditClass)
            : e.entryType === "promotional_credit"
              ? "test"
              : e.entryType === "top_up"
                ? stripeMode === "test"
                  ? "test"
                  : "paid"
                : null;
      return {
        id: e.id,
        date: e.createdAt,
        amountCents: e.amountCents,
        entryType: e.entryType,
        creditClass,
        stripeMode,
        status: "completed",
        stripePaymentIntentId: piId,
        stripeCheckoutSessionId: meta.stripeSessionId
          ? String(meta.stripeSessionId)
          : meta.stripeCheckoutSessionId
            ? String(meta.stripeCheckoutSessionId)
            : null,
        stripeEventId: meta.stripeEventId ? String(meta.stripeEventId) : null,
        description: e.description,
        referenceType: e.referenceType,
        receiptUrl: receiptUrlForPayment(piId, stripeMode),
      };
    });
}
