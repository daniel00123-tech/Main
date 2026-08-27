import { fetchTaxRatesWithFetch, type XeroTaxRateRow } from "./tax-rates";
import type { XeroFetchConfig } from "./fetch-json";

export type VatCapabilityReport = {
  available: boolean;
  officialVatReturnAccessible: boolean;
  message: string;
  taxRates: Array<{
    name: string;
    taxType: string;
    effectiveRate: number | null;
    status: string;
  }>;
  limitations: string[];
  semantics: {
    transactionLevelTax:
      "INFRA can list configured tax rates/codes and analyse transaction-level tax on invoices where exposed by Xero.";
    officialVatReturn:
      "The official submitted VAT return is NOT available through the current Xero Accounting API integration.";
  };
};

export async function buildVatCapabilityReport(
  config: XeroFetchConfig,
): Promise<VatCapabilityReport> {
  const taxRates = await fetchTaxRatesWithFetch(config);
  return {
    available: taxRates.length > 0,
    officialVatReturnAccessible: false,
    message:
      taxRates.length > 0
        ? "Transaction-level tax rates are available. INFRA can analyse tax codes on invoices but cannot retrieve the official filed VAT return through the currently available Xero API."
        : "No active tax rates were returned from Xero for this organisation.",
    taxRates: taxRates.map(formatTaxRateRow),
    limitations: [
      "Official HMRC/filed VAT return data is not exposed via the Xero Accounting API endpoints used by INFRA.",
      "Do not infer an official VAT position from invoice totals alone.",
      "Use xero_profit_and_loss or native Xero reports for accounting income; use xero_sales_summary for customer invoices raised.",
    ],
    semantics: {
      transactionLevelTax:
        "INFRA can list configured tax rates/codes and analyse transaction-level tax on invoices where exposed by Xero.",
      officialVatReturn:
        "The official submitted VAT return is NOT available through the current Xero Accounting API integration.",
    },
  };
}

export function formatTaxRateRow(row: XeroTaxRateRow) {
  return {
    name: row.Name ? String(row.Name) : "Unknown",
    taxType: row.TaxType ? String(row.TaxType) : "UNKNOWN",
    effectiveRate: row.EffectiveRate != null ? Number(row.EffectiveRate) : null,
    status: row.Status ? String(row.Status) : "ACTIVE",
  };
}

export async function listTaxRatesForMcp(config: XeroFetchConfig) {
  const report = await buildVatCapabilityReport(config);
  return {
    taxRates: report.taxRates,
    capability: report,
  };
}
