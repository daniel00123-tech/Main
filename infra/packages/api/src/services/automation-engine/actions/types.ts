import type { AutomationDefinitionRecord } from "@infra/shared";

export type AutomationExecutionContext = {
  companyId: string;
  companySlug: string;
  automation: AutomationDefinitionRecord;
  runId: string;
  initiatedBy: string | null;
  serviceIdentityId: string | null;
};

export type AutomationActionResult = {
  summary: string;
  result: Record<string, unknown>;
};
