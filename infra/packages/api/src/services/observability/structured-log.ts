/**
 * Structured production logs for Cloudflare Workers Logs.
 * Never log tokens, keys, passwords, confirmation codes, or document bodies.
 */

import { sanitizeForLog } from "../secrets/provider";

export type InfraLogLevel = "info" | "warn" | "error";

export type InfraLogEvent = {
  level?: InfraLogLevel;
  event: string;
  companyId?: string | null;
  requestId?: string | null;
  actor?: string | null;
  mcpTool?: string | null;
  connector?: string | null;
  automationId?: string | null;
  runId?: string | null;
  jobId?: string | null;
  durationMs?: number | null;
  status?: string | null;
  retryCount?: number | null;
  upstreamMs?: number | null;
  errorCategory?: string | null;
  estimatedCostUsd?: number | null;
  message?: string | null;
  [key: string]: unknown;
};

const FORBIDDEN_KEYS = /token|password|secret|authorization|api[_-]?key|cookie|confirmation/i;

export function redactInfraLogFields(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_KEYS.test(key)) continue;
    if (key === "text" || key === "content" || key === "body" || key === "document") continue;
    out[key] = sanitizeForLog(value);
  }
  return out;
}

export function logInfraEvent(event: InfraLogEvent): void {
  const level = event.level ?? "info";
  const payload = redactInfraLogFields({
    ts: new Date().toISOString(),
    service: "infra-api",
    ...event,
    level,
  });
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
