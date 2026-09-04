import { formatToolForModel, toolsForModel } from "./catalogue.js";

export const INTELLIGENCE_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["call_tool", "answer", "clarify"] },
    name: { type: "string" },
    arguments: { type: "object", additionalProperties: true },
    text: { type: "string" },
    confidence: { type: "string", enum: ["strong", "partial", "none"] },
    offer_search_other: { type: "boolean" },
    cite_source: { type: "boolean" },
  },
} as const;

export type CloudflareToolDef = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
};

export function cloudflareToolDefs(permitted?: Iterable<string> | null): CloudflareToolDef[] {
  return toolsForModel(permitted).map((tool) => ({
    name: tool.name,
    description: formatToolForModel(tool),
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(tool.parameters).map(([key, value]) => [
          key,
          { type: value.type ?? "string", description: value.description },
        ]),
      ),
      required: Object.entries(tool.parameters)
        .filter(([, value]) => value.required)
        .map(([key]) => key),
    },
  }));
}

export function workersAiToolsPayload(permitted?: Iterable<string> | null): Array<Record<string, unknown>> {
  return cloudflareToolDefs(permitted).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export function jsonSchemaResponseFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "infra_intelligence_decision",
      schema: INTELLIGENCE_DECISION_SCHEMA,
      strict: true,
    },
  };
}
