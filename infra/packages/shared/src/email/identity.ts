/** Canonical INFRA product sender for all tenants. */
export const PLATFORM_EMAIL_FROM_NAME = "Infra";
export const PLATFORM_EMAIL_FROM_ADDRESS = "noreply@infrastack.app";
export const PLATFORM_EMAIL_FROM = `${PLATFORM_EMAIL_FROM_NAME} <${PLATFORM_EMAIL_FROM_ADDRESS}>`;

export const PLATFORM_EMAIL_NO_REPLY_FOOTER =
  "This is an automated message from Infra. Replies to this address are not monitored.";

/** Reserved for future use. Not monitored. No inbound routing in V1. */
export const RESERVED_INFRA_EMAIL_ALIASES = [
  "support@infrastack.app",
  "billing@infrastack.app",
  "admin@infrastack.app",
] as const;

export function formatPlatformFromHeader(
  name = PLATFORM_EMAIL_FROM_NAME,
  address = PLATFORM_EMAIL_FROM_ADDRESS,
): string {
  return `${name.trim()} <${address.trim().toLowerCase()}>`;
}

export function isPlatformSenderAddress(address: string | null | undefined): boolean {
  return (address ?? "").trim().toLowerCase() === PLATFORM_EMAIL_FROM_ADDRESS;
}
