import { fetchAccountByCodeWithFetch, type XeroAccountRow } from "./tax-rates";
import { listAccountsWithFetch, type XeroFetchConfig } from "./tools/read";

const DEFAULT_SALES_ACCOUNT_CODE = "200";

function isRevenueAccount(row: XeroAccountRow): boolean {
  return String(row.Type ?? "").toUpperCase() === "REVENUE";
}

function normalizeAccountLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function resolveSalesAccountCodeWithFetch(
  config: XeroFetchConfig,
  input?: { accountCode?: string; accountName?: string },
): Promise<{ code: string; name: string; source: "explicit" | "default_code" | "name_match" }> {
  const explicitCode = input?.accountCode?.trim();
  if (explicitCode) {
    const account = await fetchAccountByCodeWithFetch(config, explicitCode);
    if (!account?.Code) {
      throw new Error(`Sales account code "${explicitCode}" was not found in Xero.`);
    }
    return {
      code: String(account.Code),
      name: String(account.Name ?? account.Code),
      source: "explicit",
    };
  }

  const accountsBody = await listAccountsWithFetch(config, {});
  const accounts = (accountsBody.accounts ?? []) as XeroAccountRow[];
  const active = accounts.filter((row) => String(row.Status ?? "ACTIVE").toUpperCase() === "ACTIVE");

  const label = input?.accountName?.trim();
  if (label) {
    const normalized = normalizeAccountLabel(label);
    const exact = active.find(
      (row) =>
        isRevenueAccount(row) &&
        normalizeAccountLabel(String(row.Name ?? "")) === normalized,
    );
    if (exact?.Code) {
      return {
        code: String(exact.Code),
        name: String(exact.Name ?? exact.Code),
        source: "name_match",
      };
    }
    const partial = active.find(
      (row) =>
        isRevenueAccount(row) &&
        normalizeAccountLabel(String(row.Name ?? "")).includes(normalized),
    );
    if (partial?.Code) {
      return {
        code: String(partial.Code),
        name: String(partial.Name ?? partial.Code),
        source: "name_match",
      };
    }
  }

  const defaultAccount = active.find((row) => String(row.Code ?? "") === DEFAULT_SALES_ACCOUNT_CODE);
  if (defaultAccount?.Code) {
    return {
      code: String(defaultAccount.Code),
      name: String(defaultAccount.Name ?? defaultAccount.Code),
      source: "default_code",
    };
  }

  const salesNamed = active.find(
    (row) => isRevenueAccount(row) && /sales/i.test(String(row.Name ?? "")),
  );
  if (salesNamed?.Code) {
    return {
      code: String(salesNamed.Code),
      name: String(salesNamed.Name ?? salesNamed.Code),
      source: "name_match",
    };
  }

  throw new Error("Unable to resolve a sales/revenue account in Xero.");
}
