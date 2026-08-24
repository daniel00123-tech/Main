import type { Env } from "../env";

export type McpJsonRpcResult = {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id?: string | number | null;
};

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

function parseSseOrJson(body: string): McpJsonRpcResult {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as McpJsonRpcResult;
  }

  const dataLine = trimmed
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data:"));

  if (!dataLine) {
    throw new Error("MCP response did not contain JSON or SSE data");
  }

  return JSON.parse(dataLine.slice(5).trim()) as McpJsonRpcResult;
}

export function resolveMcpAuthHeader(
  env: Env,
  authSecretRef: string | null | undefined,
): { authorizationHeader: string | null; authConfigured: boolean } {
  if (!authSecretRef) {
    return { authorizationHeader: null, authConfigured: false };
  }

  const secretValue = (env as Record<string, unknown>)[authSecretRef];
  if (typeof secretValue !== "string" || !secretValue) {
    return { authorizationHeader: null, authConfigured: false };
  }

  if (secretValue.toLowerCase().startsWith("bearer ")) {
    return { authorizationHeader: secretValue, authConfigured: true };
  }

  return {
    authorizationHeader: `Bearer ${secretValue}`,
    authConfigured: true,
  };
}

function resolveMcpFetcher(
  env: Env,
  serviceBindingRef?: string | null,
): Fetcher | null {
  if (!serviceBindingRef) return null;
  const binding = (env as Record<string, unknown>)[serviceBindingRef];
  if (
    binding &&
    typeof binding === "object" &&
    "fetch" in binding &&
    typeof (binding as Fetcher).fetch === "function"
  ) {
    return binding as Fetcher;
  }
  return null;
}

export async function mcpRequest(
  env: Env,
  input: {
    endpointUrl: string;
    authSecretRef?: string | null;
    serviceBindingRef?: string | null;
    method: string;
    params?: Record<string, unknown>;
    id?: number;
  },
): Promise<{
  payload: McpJsonRpcResult;
  latencyMs: number;
  authConfigured: boolean;
  httpStatus: number;
}> {
  const { authorizationHeader, authConfigured } = resolveMcpAuthHeader(
    env,
    input.authSecretRef,
  );

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2024-11-05",
  };

  if (authorizationHeader) {
    headers.Authorization = authorizationHeader;
  }

  const endpoint = new URL(input.endpointUrl);
  const fetcher = resolveMcpFetcher(env, input.serviceBindingRef);

  // Service bindings omit Host unless set explicitly; some MCP Workers require it.
  if (fetcher) {
    headers.Host = endpoint.host;
  }

  const request = new Request(input.endpointUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: input.id ?? 1,
      method: input.method,
      params: input.params ?? {},
    }),
    signal: AbortSignal.timeout(20000),
  });

  const started = Date.now();
  const response = fetcher ? await fetcher.fetch(request) : await fetch(request);

  const latencyMs = Date.now() - started;
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `MCP HTTP ${response.status}: ${text.slice(0, 240) || response.statusText}`,
    );
  }

  const payload = parseSseOrJson(text);
  if (payload.error) {
    throw new Error(payload.error.message || "MCP JSON-RPC error");
  }

  return { payload, latencyMs, authConfigured, httpStatus: response.status };
}

export async function listMcpTools(
  env: Env,
  endpointUrl: string,
  authSecretRef?: string | null,
  serviceBindingRef?: string | null,
): Promise<{ tools: McpToolDefinition[]; latencyMs: number; authConfigured: boolean }> {
  const { payload, latencyMs, authConfigured } = await mcpRequest(env, {
    endpointUrl,
    authSecretRef,
    serviceBindingRef,
    method: "tools/list",
    id: 2,
  });

  const result = payload.result as { tools?: McpToolDefinition[] } | undefined;
  return {
    tools: result?.tools ?? [],
    latencyMs,
    authConfigured,
  };
}

export async function callMcpTool(
  env: Env,
  input: {
    endpointUrl: string;
    authSecretRef?: string | null;
    serviceBindingRef?: string | null;
    toolName: string;
    arguments?: Record<string, unknown>;
  },
): Promise<{
  result: unknown;
  latencyMs: number;
  authConfigured: boolean;
  textContent: string | null;
}> {
  const { payload, latencyMs, authConfigured } = await mcpRequest(env, {
    endpointUrl: input.endpointUrl,
    authSecretRef: input.authSecretRef,
    serviceBindingRef: input.serviceBindingRef,
    method: "tools/call",
    id: 3,
    params: {
      name: input.toolName,
      arguments: input.arguments ?? {},
    },
  });

  const result = payload.result as
    | { content?: Array<{ type?: string; text?: string }> }
    | undefined;

  const textContent =
    result?.content?.find((item) => item.type === "text" && item.text)?.text ??
    null;

  return {
    result: payload.result,
    latencyMs,
    authConfigured,
    textContent,
  };
}

export function extractKnowledgeCounts(textContent: string | null): {
  documentCount: number | null;
  chunkCount: number | null;
} {
  if (!textContent) return { documentCount: null, chunkCount: null };
  try {
    const parsed = JSON.parse(textContent) as {
      tables?: Array<{ name?: string; recordCount?: number }>;
    };
    const docs = parsed.tables?.find((t) => t.name === "knowledge_documents");
    const chunks = parsed.tables?.find((t) => t.name === "knowledge_chunks");
    return {
      documentCount: docs?.recordCount ?? null,
      chunkCount: chunks?.recordCount ?? null,
    };
  } catch {
    return { documentCount: null, chunkCount: null };
  }
}
