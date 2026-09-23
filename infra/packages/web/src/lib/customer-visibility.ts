/** Internal acceptance artefacts that must not appear in the company portal. */

const INTERNAL_AUTOMATION_NAMES = [
  /^infra automation scheduler test$/i,
  /^infra automation engine test$/i,
];

const INTERNAL_ACTION_HINTS = [
  /infra automation (scheduler|engine) test/i,
  /automation engine test/i,
  /historic test invoice/i,
];

export function isInternalTestAutomationName(name: string | null | undefined): boolean {
  const value = String(name ?? "").trim();
  return INTERNAL_AUTOMATION_NAMES.some((pattern) => pattern.test(value));
}

export function isInternalTestAction(input: {
  summary?: string | null;
  requestedAction?: string | null;
  actor?: string | null;
}): boolean {
  const hay = [input.summary, input.requestedAction, input.actor]
    .filter(Boolean)
    .join(" ");
  return INTERNAL_ACTION_HINTS.some((pattern) => pattern.test(hay));
}

export function filterCustomerAutomations<T extends { name?: string | null }>(
  items: T[],
  isPlatformAdmin: boolean,
): T[] {
  if (isPlatformAdmin) return items;
  return items.filter((item) => !isInternalTestAutomationName(item.name));
}

export function filterCustomerActions<
  T extends { summary?: string | null; requestedAction?: string | null; actor?: string | null },
>(items: T[], isPlatformAdmin: boolean): T[] {
  if (isPlatformAdmin) return items;
  return items.filter((item) => !isInternalTestAction(item));
}

export function automationSchedulePreview(input: {
  frequency: string;
  time: string;
  timezone: string;
}): string {
  const zone = input.timezone || "Europe/London";
  switch (input.frequency) {
    case "daily":
      return `Runs every day at ${input.time} ${zone}.`;
    case "weekdays":
      return `Runs every weekday at ${input.time} ${zone}.`;
    case "weekly":
      return `Runs weekly at ${input.time} ${zone}.`;
    case "monthly":
      return `Runs monthly at ${input.time} ${zone}.`;
    default:
      return `Runs ${input.frequency} at ${input.time} ${zone}.`;
  }
}
