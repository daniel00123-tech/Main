import type { Env } from "../env";
import { loadMicrosoftConfig, type ElMicrosoftConfig } from "./config";
import { ElMicrosoftError } from "./errors";
import { createGraphClient, type GraphClient } from "./graph";
import { loadPolicy } from "./directory";
import type { AccessPolicy } from "./policy";

export type MicrosoftContext = {
  env: Env;
  config: ElMicrosoftConfig;
  graph: GraphClient;
  policy: AccessPolicy;
};

export async function createMicrosoftContext(env: Env): Promise<MicrosoftContext> {
  const config = loadMicrosoftConfig(env);
  if (!config) {
    throw new ElMicrosoftError(
      "Microsoft 365 is not configured on EL Business MCP. EL_MS_TENANT_ID, EL_MS_CLIENT_ID and EL_MS_CLIENT_SECRET are required.",
      "EL_MS_NOT_CONFIGURED",
      503
    );
  }
  const graph = await createGraphClient(config);
  const policy = await loadPolicy(graph, config);
  return { env, config, graph, policy };
}

export function jsonTool(data: unknown, isError = false): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}
