import { xeroGetJson, type XeroFetchConfig } from "./fetch-json";

export type XeroTaxRateRow = {
  Name?: string;
  TaxType?: string;
  EffectiveRate?: number;
  Status?: string;
};

export type XeroAccountRow = {
  Code?: string;
  Name?: string;
  TaxType?: string;
  Type?: string;
};

export async function fetchTaxRatesWithFetch(
  config: XeroFetchConfig,
): Promise<XeroTaxRateRow[]> {
  const body = await xeroGetJson<{ TaxRates?: XeroTaxRateRow[] }>(config, "/TaxRates");
  return (body.TaxRates ?? []).filter(
    (row) => String(row.Status ?? "ACTIVE").toUpperCase() === "ACTIVE",
  );
}

export async function fetchAccountByCodeWithFetch(
  config: XeroFetchConfig,
  accountCode: string,
): Promise<XeroAccountRow | null> {
  const escaped = accountCode.replace(/"/g, "");
  const body = await xeroGetJson<{ Accounts?: XeroAccountRow[] }>(config, "/Accounts", {
    where: `Code=="${escaped}"`,
  });
  return body.Accounts?.[0] ?? null;
}

/** Map natural-language VAT treatment to a valid Xero TaxType for this tenant. */
export function pickTaxTypeForTreatment(
  taxRates: XeroTaxRateRow[],
  input: { taxTreatment?: string; accountDefaultTaxType?: string | null },
): { taxType: string; label: string; source: "explicit" | "account_default" | "tax_rates_lookup" } {
  const treatment = input.taxTreatment?.trim().toLowerCase() ?? "";
  if (/^taxtype:/.test(treatment)) {
    const explicit = treatment.slice("taxtype:".length).trim().toUpperCase();
    const match = taxRates.find((row) => String(row.TaxType ?? "").toUpperCase() === explicit);
    return {
      taxType: explicit,
      label: match?.Name ? String(match.Name) : explicit,
      source: "explicit",
    };
  }

  const wantsNoVat = /no vat|none|zero rated|zero-rated|0%|exempt|without vat|no tax/.test(
    treatment,
  );

  if (wantsNoVat) {
    const exactNoVat = taxRates.find((row) => /^no vat$/i.test(String(row.Name ?? "").trim()));
    if (exactNoVat?.TaxType) {
      return {
        taxType: String(exactNoVat.TaxType),
        label: String(exactNoVat.Name ?? exactNoVat.TaxType),
        source: "tax_rates_lookup",
      };
    }

    const noneType = taxRates.find((row) => String(row.TaxType ?? "").toUpperCase() === "NONE");
    if (noneType?.TaxType) {
      return {
        taxType: String(noneType.TaxType),
        label: String(noneType.Name ?? "NONE"),
        source: "tax_rates_lookup",
      };
    }

    const byName = taxRates.find((row) => /no vat/i.test(String(row.Name ?? "")));
    if (byName?.TaxType) {
      return {
        taxType: String(byName.TaxType),
        label: String(byName.Name ?? byName.TaxType),
        source: "tax_rates_lookup",
      };
    }

    const zeroOutput = taxRates.find(
      (row) =>
        Number(row.EffectiveRate ?? -1) === 0 &&
        /OUTPUT|EXEMPT|NONE|ZERO/i.test(String(row.TaxType ?? "")),
    );
    if (zeroOutput?.TaxType) {
      return {
        taxType: String(zeroOutput.TaxType),
        label: String(zeroOutput.Name ?? zeroOutput.TaxType),
        source: "tax_rates_lookup",
      };
    }
    if (input.accountDefaultTaxType) {
      return {
        taxType: input.accountDefaultTaxType,
        label: `Account default (${input.accountDefaultTaxType})`,
        source: "account_default",
      };
    }
  }

  if (input.accountDefaultTaxType) {
    const match = taxRates.find((row) => row.TaxType === input.accountDefaultTaxType);
    return {
      taxType: input.accountDefaultTaxType,
      label: match?.Name ? String(match.Name) : input.accountDefaultTaxType,
      source: "account_default",
    };
  }

  throw new Error(
    `Unable to resolve Xero TaxType for treatment "${input.taxTreatment ?? "default"}". Provide taxType explicitly.`,
  );
}

export async function resolveXeroTaxTypeForDraftInvoice(
  config: XeroFetchConfig,
  input: { taxTreatment?: string; accountCode?: string; taxType?: string },
): Promise<{ taxType: string; label: string; source: string }> {
  if (input.taxType?.trim()) {
    return {
      taxType: input.taxType.trim(),
      label: input.taxType.trim(),
      source: "explicit_taxType",
    };
  }

  const taxRates = await fetchTaxRatesWithFetch(config);
  let accountDefault: string | null = null;
  if (input.accountCode?.trim()) {
    const account = await fetchAccountByCodeWithFetch(config, input.accountCode.trim());
    accountDefault = account?.TaxType ? String(account.TaxType) : null;
  }

  const picked = pickTaxTypeForTreatment(taxRates, {
    taxTreatment: input.taxTreatment,
    accountDefaultTaxType: accountDefault,
  });
  return picked;
}
