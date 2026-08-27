/**
 * Push Microsoft documents into the company Business MCP knowledge corpus.
 * Reuses Caddington /admin/knowledge/upload + /admin/knowledge/{id}/index.
 */

import type { Env } from "../env";
import type { McpEnvironment } from "@infra/shared";
import { resolveMcpFetcher } from "./mcp-client";

export type KnowledgeUploadResult =
  | { ok: true; documentId: number; externalId: string; indexed: boolean }
  | { ok: false; code: string; message: string };

function adminAuthHeader(env: Env): string | null {
  const token =
    typeof env.CADDINGTON_ADMIN_TOKEN === "string" ? env.CADDINGTON_ADMIN_TOKEN.trim() : "";
  return token ? `Bearer ${token}` : null;
}

async function adminFetch(
  env: Env,
  mcp: McpEnvironment,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const auth = adminAuthHeader(env);
  if (!auth) {
    throw new Error("CADDINGTON_ADMIN_TOKEN is not configured on infra-api");
  }

  const binding = resolveMcpFetcher(env, mcp.serviceBindingRef ?? "CADDINGTON_MCP");
  const url = `https://company-mcp.internal${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", auth);

  if (binding) {
    return binding.fetch(new Request(url, { ...init, headers }));
  }

  const base = mcp.endpointUrl.replace(/\/mcp\/?$/, "");
  return fetch(`${base}${path}`, { ...init, headers });
}

export async function uploadMicrosoftDocumentToKnowledge(
  env: Env,
  mcp: McpEnvironment,
  input: {
    filename: string;
    bytes: ArrayBuffer;
    mimeType: string | null;
    externalId: string;
    title: string;
    metadata: Record<string, unknown>;
    autoIndex?: boolean;
  },
): Promise<KnowledgeUploadResult> {
  try {
    const form = new FormData();
    form.append("file", new Blob([input.bytes], { type: input.mimeType ?? "application/octet-stream" }), input.filename);
    form.append("title", input.title);
    form.append("external_id", input.externalId);
    form.append("source", "microsoft_365");
    form.append("category", String(input.metadata.sourceType ?? "document"));
    if (input.metadata.topic) form.append("topic", String(input.metadata.topic));
    if (input.metadata.connector) form.append("company", String(input.metadata.companyId ?? ""));

    const uploadResponse = await adminFetch(env, mcp, "/admin/knowledge/upload", {
      method: "POST",
      body: form,
    });

    const uploadBody = (await uploadResponse.json().catch(() => ({}))) as {
      ok?: boolean;
      documentId?: number;
      externalId?: string;
      error?: string;
    };

    if (!uploadResponse.ok || !uploadBody.documentId) {
      return {
        ok: false,
        code: "KNOWLEDGE_UPLOAD_FAILED",
        message: uploadBody.error ?? `Upload HTTP ${uploadResponse.status}`,
      };
    }

    let indexed = false;
    if (input.autoIndex !== false) {
      const indexResponse = await adminFetch(
        env,
        mcp,
        `/admin/knowledge/${uploadBody.documentId}/index`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      const indexBody = (await indexResponse.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      indexed = indexResponse.ok && indexBody.ok !== false;
      if (!indexed) {
        return {
          ok: false,
          code: "KNOWLEDGE_INDEX_FAILED",
          message: indexBody.error ?? `Index HTTP ${indexResponse.status}`,
        };
      }
    }

    return {
      ok: true,
      documentId: uploadBody.documentId,
      externalId: uploadBody.externalId ?? input.externalId,
      indexed,
    };
  } catch (err) {
    return {
      ok: false,
      code: "KNOWLEDGE_BRIDGE_ERROR",
      message: err instanceof Error ? err.message : "Knowledge bridge failed",
    };
  }
}

export function buildMicrosoftExternalId(input: {
  sourceType: string;
  driveId: string;
  itemId: string;
}): string {
  return `microsoft-${input.sourceType}-${input.driveId}-${input.itemId}`.replace(/[^a-zA-Z0-9._-]/g, "_");
}
