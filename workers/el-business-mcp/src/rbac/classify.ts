export const DATA_CLASSIFICATIONS = [
  "engineer_knowledge",
  "company_general",
  "finance",
  "restricted_management",
] as const;

export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export const CLASSIFICATION_LABELS: Record<DataClassification, string> = {
  engineer_knowledge: "Engineer Knowledge",
  company_general: "General Company",
  finance: "Finance",
  restricted_management: "Restricted Management",
};

export const CLASSIFICATION_READ_CAPABILITY = {
  engineer_knowledge: "knowledge.engineer.read",
  company_general: "knowledge.company.read",
  finance: "knowledge.finance.read",
  restricted_management: "knowledge.restricted.read",
} as const;

/**
 * Conservative sensitive-term hints for review. Explicit classification always wins.
 * These must not be the only security boundary.
 */
export const RESTRICTED_REVIEW_TERMS = [
  "hr",
  "employment",
  "contract of employment",
  "salary",
  "payroll",
  "disciplinary",
  "grievance",
  "board",
  "shareholder",
  "shareholders agreement",
  "settlement",
  "personnel",
] as const;

export const FINANCE_REVIEW_TERMS = [
  "vat return",
  "corporation tax",
  "bank statement",
  "remittance advice",
  "aged payables",
  "profit and loss",
  "balance sheet",
] as const;

export type ClassificationResolution = {
  classification: DataClassification;
  source: "explicit" | "directory" | "default";
  reviewFlags: Array<{ suggested: DataClassification; term: string }>;
  explicitOverride: boolean;
};

export function isDataClassification(value: string): value is DataClassification {
  return (DATA_CLASSIFICATIONS as readonly string[]).includes(value);
}

export function detectReviewFlags(input: {
  name?: string | null;
  path?: string | null;
  webUrl?: string | null;
}): Array<{ suggested: DataClassification; term: string }> {
  const hay = `${input.name ?? ""} ${input.path ?? ""} ${input.webUrl ?? ""}`.toLowerCase();
  const flags: Array<{ suggested: DataClassification; term: string }> = [];
  for (const term of RESTRICTED_REVIEW_TERMS) {
    if (hay.includes(term)) flags.push({ suggested: "restricted_management", term });
  }
  for (const term of FINANCE_REVIEW_TERMS) {
    if (hay.includes(term)) flags.push({ suggested: "finance", term });
  }
  return flags;
}

export function resolveClassification(input: {
  explicit?: string | null;
  directory?: string | null;
  name?: string | null;
  path?: string | null;
  webUrl?: string | null;
}): ClassificationResolution {
  const reviewFlags = detectReviewFlags(input);
  if (input.explicit && isDataClassification(input.explicit)) {
    return {
      classification: input.explicit,
      source: "explicit",
      reviewFlags,
      explicitOverride: true,
    };
  }
  if (input.directory && isDataClassification(input.directory)) {
    return {
      classification: input.directory,
      source: "directory",
      reviewFlags,
      explicitOverride: false,
    };
  }
  return {
    classification: "company_general",
    source: "default",
    reviewFlags,
    explicitOverride: false,
  };
}

/**
 * Fail-closed visibility: automated restricted flags hide content from roles
 * that cannot read restricted_management until an admin classifies otherwise.
 * Finance flags do not imply restricted_management.
 */
export function effectiveClassificationForAccess(
  resolution: ClassificationResolution
): DataClassification {
  if (resolution.explicitOverride) return resolution.classification;
  if (resolution.classification === "restricted_management") return "restricted_management";
  if (resolution.reviewFlags.some((flag) => flag.suggested === "restricted_management")) {
    return "restricted_management";
  }
  return resolution.classification;
}
