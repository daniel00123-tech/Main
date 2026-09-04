import { redactSecretFields } from "../secrets";

const SECRET_PATTERN =
  /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]+|api[_-]?key\s*[:=]\s*\S+)/gi;

export function stripSecrets(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.replace(SECRET_PATTERN, "[redacted]").slice(0, 4_000);
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(redactSecretFields(asRecord(value)));
  } catch {
    return "[]";
  }
}

export function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { items: value };
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return {};
}

export function evidenceRefsOnly(
  refs: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> {
  return (refs ?? []).map((ref) => ({
    companyId: typeof ref.companyId === "string" ? ref.companyId : null,
    source: typeof ref.source === "string" ? ref.source : null,
    toolName: typeof ref.toolName === "string" ? ref.toolName : null,
    timestamp: typeof ref.timestamp === "string" ? ref.timestamp : null,
  }));
}
