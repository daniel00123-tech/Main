/**
 * Safe send-invoice test recipient override.
 * Only active when XERO_SEND_UAT_MODE=true — cannot redirect production sends.
 */

import type { Env } from "../../env";

export type SendRecipientResolution = {
  intendedRecipient: string | null;
  effectiveRecipient: string | null;
  testOverrideActive: boolean;
  testOverrideRecipient: string | null;
  warning: string | null;
};

export function isSendUatModeEnabled(env: Env): boolean {
  const flag = env.XERO_SEND_UAT_MODE;
  return flag === "true" || flag === "1";
}

export function resolveSendRecipient(
  env: Env,
  intendedEmail: string | null | undefined,
): SendRecipientResolution {
  const intended = intendedEmail?.trim() || null;
  const overrideRaw =
    typeof env.XERO_SEND_TEST_RECIPIENT === "string"
      ? env.XERO_SEND_TEST_RECIPIENT.trim()
      : null;
  const uatMode = isSendUatModeEnabled(env);

  if (!uatMode || !overrideRaw) {
    return {
      intendedRecipient: intended,
      effectiveRecipient: intended,
      testOverrideActive: false,
      testOverrideRecipient: null,
      warning: null,
    };
  }

  return {
    intendedRecipient: intended,
    effectiveRecipient: overrideRaw,
    testOverrideActive: true,
    testOverrideRecipient: overrideRaw,
    warning: `UAT MODE: email will be sent to test recipient ${overrideRaw} instead of ${intended ?? "contact email"}.`,
  };
}

/** Block override if production environment without explicit UAT flag. */
export function assertSendOverrideSafe(env: Env): { ok: true } | { ok: false; message: string } {
  const override =
    typeof env.XERO_SEND_TEST_RECIPIENT === "string" && env.XERO_SEND_TEST_RECIPIENT.trim();
  if (!override) return { ok: true };
  if (!isSendUatModeEnabled(env)) {
    return {
      ok: false,
      message: "XERO_SEND_TEST_RECIPIENT is set but XERO_SEND_UAT_MODE is not enabled — override blocked.",
    };
  }
  if (env.ENVIRONMENT === "production" && !isSendUatModeEnabled(env)) {
    return {
      ok: false,
      message: "Send test override cannot operate in production without XERO_SEND_UAT_MODE.",
    };
  }
  return { ok: true };
}
