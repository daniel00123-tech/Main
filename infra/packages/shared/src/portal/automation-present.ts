import type { AutomationDefinitionRecord } from "../automation-engine/types";

function formatScheduleTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Customer-facing schedule description — no RRULE/cron/timezone jargon in primary UI. */
export function humanAutomationSchedule(automation: Pick<
  AutomationDefinitionRecord,
  "triggerType" | "schedule" | "timezone"
>): string {
  if (automation.triggerType === "manual") return "Runs when you start it";
  if (!automation.schedule) return "Scheduled";

  const hour = automation.schedule.hour ?? 0;
  const minute = automation.schedule.minute ?? 0;
  const time = formatScheduleTime(hour, minute);

  switch (automation.schedule.frequency) {
    case "hourly":
      return "Runs every hour";
    case "daily":
      return `Every day at ${time}`;
    case "weekdays":
      return `Every weekday at ${time}`;
    case "weekly":
      return `Runs weekly at ${time}`;
    case "monthly":
      return `Runs monthly at ${time}`;
    default:
      return `Runs ${automation.schedule.frequency} at ${time}`;
  }
}

export function humanAutomationCustomerStatus(status: string): string {
  switch (status) {
    case "active":
      return "Active";
    case "paused":
      return "Paused";
    case "draft":
      return "Draft";
    case "disabled":
      return "Disabled";
    case "error":
      return "Needs attention";
    default:
      return status.replace(/_/g, " ");
  }
}

export function humanAutomationRunCustomerSummary(input: {
  status: string;
  resultSummary?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  result?: Record<string, unknown> | null;
}): string {
  const fromResult =
    typeof input.result?.customerSummary === "string" ? input.result.customerSummary : null;
  if (fromResult) return fromResult;
  if (input.status === "completed") {
    return input.resultSummary?.trim() || "Completed";
  }
  if (input.errorCode === "XERO_UNAVAILABLE" || /xero/i.test(input.errorMessage ?? "")) {
    return "Couldn't retrieve Xero sales data";
  }
  if (input.errorCode === "EMAIL_DELIVERY_FAILED") {
    return "Sales report generated, email not sent";
  }
  return input.errorMessage?.trim() || "Failed";
}

export function humanAutomationWhen(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return fmt.format(date);
}

export function humanAutomationNextRun(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const nowParts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const runParts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (parts: Intl.DateTimeFormatPart[], type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const sameDay =
    pick(nowParts, "year") === pick(runParts, "year") &&
    pick(nowParts, "month") === pick(runParts, "month") &&
    pick(nowParts, "day") === pick(runParts, "day");
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowParts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(tomorrow);
  const isTomorrow =
    pick(tomorrowParts, "year") === pick(runParts, "year") &&
    pick(tomorrowParts, "month") === pick(runParts, "month") &&
    pick(tomorrowParts, "day") === pick(runParts, "day");
  const time = `${pick(runParts, "hour")}:${pick(runParts, "minute")}`;
  if (sameDay) return `Today, ${time}`;
  if (isTomorrow) return `Tomorrow, ${time}`;
  return humanAutomationWhen(iso, timeZone);
}

export function humanAutomationRunCustomerStatus(status: string): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "running":
      return "Running";
    case "queued":
      return "Running";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status.replace(/_/g, " ");
  }
}
