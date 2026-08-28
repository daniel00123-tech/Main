import type { OperationalIncident, OperationalSeverity } from "./health-model";

const SEVERITY_RANK: Record<OperationalSeverity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
};

export type IncidentDedupInput = Omit<
  OperationalIncident,
  "occurrenceCount" | "firstObservedAt" | "lastObservedAt" | "resolved"
> & {
  observedAt?: string;
  occurrenceCount?: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
};

/**
 * Group repeated operational incidents within a time window.
 * Raw audit evidence remains in source tables — this is presentation dedup only.
 */
export function deduplicateOperationalIncidents(
  items: IncidentDedupInput[],
  windowMs = 2 * 60 * 60 * 1000,
): OperationalIncident[] {
  const groups = new Map<string, OperationalIncident>();

  for (const item of items) {
    const observedAt = item.observedAt ?? new Date().toISOString();
    const bucket = Math.floor(Date.parse(observedAt) / windowMs);
    const key = [
      item.companyId ?? "platform",
      item.subsystem,
      item.category,
      item.title,
      bucket,
    ].join("|");

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        ...item,
        occurrenceCount: item.occurrenceCount ?? 1,
        firstObservedAt: item.firstObservedAt ?? observedAt,
        lastObservedAt: item.lastObservedAt ?? observedAt,
        resolved: false,
      });
      continue;
    }

    existing.occurrenceCount += item.occurrenceCount ?? 1;
    const first = Date.parse(existing.firstObservedAt);
    const last = Date.parse(existing.lastObservedAt);
    const current = Date.parse(observedAt);
    if (current < first) existing.firstObservedAt = observedAt;
    if (current > last) existing.lastObservedAt = observedAt;
    if (SEVERITY_RANK[item.severity] < SEVERITY_RANK[existing.severity]) {
      existing.severity = item.severity;
    }
  }

  return [...groups.values()].sort((a, b) => {
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severity !== 0) return severity;
    return Date.parse(b.lastObservedAt) - Date.parse(a.lastObservedAt);
  });
}

export function formatIncidentOccurrenceSummary(incident: OperationalIncident): string {
  if (incident.occurrenceCount <= 1) return incident.summary;
  return `${incident.summary} (${incident.occurrenceCount} occurrences since ${incident.firstObservedAt})`;
}
