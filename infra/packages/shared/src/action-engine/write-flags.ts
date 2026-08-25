/**
 * Centralised write feature flags.
 * Production financial writes remain disabled until operator approval.
 */

export type WriteFeatureFlags = {
  /** Architecture supports connector writes. */
  writesSupported: boolean;
  /** Global production write gate (legacy alias: FINANCIAL_WRITES_ENABLED). */
  writesEnabled: boolean;
  /** Financial actions (invoices, credits, payments). */
  financialWritesEnabled: boolean;
  /** Destructive actions (void, delete). */
  destructiveWritesEnabled: boolean;
};

/** Default production-safe flags — do not enable writes without explicit operator approval. */
export const DEFAULT_WRITE_FEATURE_FLAGS: WriteFeatureFlags = {
  writesSupported: true,
  writesEnabled: false,
  financialWritesEnabled: false,
  destructiveWritesEnabled: false,
};

export function resolveWriteFeatureFlags(input?: Partial<WriteFeatureFlags>): WriteFeatureFlags {
  return { ...DEFAULT_WRITE_FEATURE_FLAGS, ...input };
}
