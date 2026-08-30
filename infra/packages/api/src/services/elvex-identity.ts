import { ELVEX_COMPANY_ID, ELVEX_COMPANY_SLUG } from "@infra/shared";

export async function elvexIdentityHeaders(
  secret: string | undefined,
  input: {
    actorId: string;
    email: string;
    displayName?: string | null;
    principalType?: "user" | "service";
    correlationId?: string | null;
  },
): Promise<Record<string, string>> {
  if (!secret?.trim()) return {};
  const timestamp = new Date().toISOString();
  const principalType = input.principalType ?? "user";
  const correlationId = input.correlationId ?? "";
  const payload = [
    input.actorId,
    input.email.toLowerCase(),
    principalType,
    timestamp,
    correlationId,
  ].join("\n");
  const signature = await hmacHex(secret, payload);
  return {
    "X-Elvex-Actor-Id": input.actorId,
    "X-Elvex-Actor-Email": input.email,
    "X-Elvex-Actor-Name": input.displayName ?? "",
    "X-Elvex-Principal-Type": principalType,
    "X-Elvex-Identity-Ts": timestamp,
    "X-Elvex-Correlation-Id": correlationId,
    "X-Elvex-Identity-Sig": signature,
  };
}

export function isElvexMcpCompany(company: { id?: string | null; slug?: string | null }): boolean {
  return company.id === ELVEX_COMPANY_ID || company.slug === ELVEX_COMPANY_SLUG;
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
