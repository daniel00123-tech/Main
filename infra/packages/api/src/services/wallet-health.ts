import { getWalletBalance } from "./ledger";
import { getCompanySettings } from "./company-settings";
import { createNotification } from "./notifications";
import { classifyLedgerCredit } from "./wallet-credits";
import { listLedgerEntries } from "./ledger";

export type WalletHealthState = "healthy" | "low" | "critical" | "empty";

export function resolveWalletHealthState(
  balanceCents: number,
  thresholdCents: number,
): WalletHealthState {
  if (balanceCents <= 0) return "empty";
  if (balanceCents <= Math.max(100, Math.floor(thresholdCents * 0.25))) return "critical";
  if (balanceCents <= thresholdCents) return "low";
  return "healthy";
}

export async function getWalletHealth(
  db: D1Database,
  companyId: string,
): Promise<{
  state: WalletHealthState;
  balanceCents: number;
  thresholdCents: number;
  promotionalCents: number;
  paidCents: number;
}> {
  const [wallet, settings, credits] = await Promise.all([
    getWalletBalance(db, companyId),
    getCompanySettings(db, companyId),
    listLedgerEntries(db, companyId, 500),
  ]);
  const classified = classifyLedgerCredit(credits);
  const threshold = settings?.lowBalanceThresholdCents ?? 500;
  return {
    state: resolveWalletHealthState(wallet.balanceCents, threshold),
    balanceCents: wallet.balanceCents,
    thresholdCents: threshold,
    promotionalCents: classified.testCents,
    paidCents: classified.paidCents,
  };
}

export async function maybeNotifyWalletHealth(
  db: D1Database,
  companyId: string,
): Promise<void> {
  const health = await getWalletHealth(db, companyId);
  const href = `/portal/billing`;

  if (health.state === "empty") {
    await createNotification(db, {
      companyId,
      type: "empty_balance",
      severity: "critical",
      title: "Wallet empty",
      body: "Your INFRA credit balance is empty. Add credit to continue using chargeable features.",
      href,
      dedupKey: "wallet_empty",
      dedupWindowHours: 12,
    });
  } else if (health.state === "critical") {
    await createNotification(db, {
      companyId,
      type: "critical_balance",
      severity: "critical",
      title: "Critical balance",
      body: `Your wallet balance is critically low (£${(health.balanceCents / 100).toFixed(2)}). Add credit soon.`,
      href,
      dedupKey: "wallet_critical",
      dedupWindowHours: 24,
    });
  } else if (health.state === "low") {
    await createNotification(db, {
      companyId,
      type: "low_balance",
      severity: "warning",
      title: "Low balance",
      body: `Your wallet balance is below £${(health.thresholdCents / 100).toFixed(2)}.`,
      href,
      dedupKey: "wallet_low",
      dedupWindowHours: 48,
    });
  }
}
