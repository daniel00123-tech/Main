import type { AutomationDefinitionRecord } from "../automation-engine/types";

function formatScheduleTime(hour: number, minute: number): string {
  const h = hour % 12 || 12;
  const ampm = hour < 12 ? "am" : "pm";
  const m = minute > 0 ? `:${String(minute).padStart(2, "0")}` : "";
  return `${h}${m}${ampm}`;
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
      return `Runs daily at ${time}`;
    case "weekdays":
      return `Runs every weekday at ${time}`;
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
