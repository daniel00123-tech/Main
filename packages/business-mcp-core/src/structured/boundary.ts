export type StructuredDataAccessMode = "warehouse" | "live_api" | "not_configured";

export interface StructuredDataBoundary {
  mode: StructuredDataAccessMode;
  description: string;
}

export const WAREHOUSE_BOUNDARY: StructuredDataBoundary = {
  mode: "warehouse",
  description:
    "Read-only access to company-specific warehouse tables ingested incrementally from business systems.",
};

export const LIVE_API_BOUNDARY: StructuredDataBoundary = {
  mode: "live_api",
  description:
    "Direct live API access to operational systems. Distinct from warehouse/historical data.",
};

export const NOT_CONFIGURED_BOUNDARY: StructuredDataBoundary = {
  mode: "not_configured",
  description: "Structured data access is not configured for this company MCP.",
};

export function describeStructuredDataMode(
  mode: StructuredDataAccessMode
): StructuredDataBoundary {
  switch (mode) {
    case "warehouse":
      return WAREHOUSE_BOUNDARY;
    case "live_api":
      return LIVE_API_BOUNDARY;
    default:
      return NOT_CONFIGURED_BOUNDARY;
  }
}
