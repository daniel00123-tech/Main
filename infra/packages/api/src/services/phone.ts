export const UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE =
  "This number is not associated with an active Infra account. Please contact your administrator.";

export class MobileValidationError extends Error {
  readonly code = "INVALID_MOBILE";
  constructor(message: string) {
    super(message);
    this.name = "MobileValidationError";
  }
}

export class MobileCollisionError extends Error {
  readonly code = "MOBILE_COLLISION";
  constructor(message = "This mobile number is already associated with another Infra user") {
    super(message);
    this.name = "MobileCollisionError";
  }
}

/**
 * Normalise a mobile number to E.164.
 * UK national numbers starting 07 are treated as +44.
 * Example accepted UK form: +447700900123
 */
export function normalizeE164(input: string | null | undefined): string {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new MobileValidationError("Mobile number is required in international E.164 format, for example +447700900123");
  }

  const compact = raw.replace(/[\s().-]/g, "");
  let digits: string;

  if (compact.startsWith("+")) {
    digits = compact.slice(1).replace(/\D/g, "");
  } else if (compact.startsWith("00")) {
    digits = compact.slice(2).replace(/\D/g, "");
  } else if (compact.startsWith("07") && compact.replace(/\D/g, "").length === 11) {
    digits = `44${compact.replace(/\D/g, "").slice(1)}`;
  } else {
    digits = compact.replace(/\D/g, "");
    if (digits.startsWith("44") && digits.length === 12) {
      // already country-coded without +
    } else {
      throw new MobileValidationError(
        "Enter a mobile number in international E.164 format, for example +447700900123",
      );
    }
  }

  if (!/^[1-9]\d{7,14}$/.test(digits)) {
    throw new MobileValidationError(
      "Enter a valid international mobile number in E.164 format, for example +447700900123",
    );
  }

  return `+${digits}`;
}

export function tryNormalizeE164(input: string | null | undefined): {
  ok: true;
  e164: string;
} | {
  ok: false;
  error: string;
} {
  try {
    return { ok: true, e164: normalizeE164(input) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid mobile number",
    };
  }
}

export function maskMobileE164(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, "");
  if (digits.length < 6) return "••••";
  return `+${digits.slice(0, 2)}••••${digits.slice(-4)}`;
}
