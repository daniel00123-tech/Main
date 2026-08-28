/**
 * MCP admin helpers for OCR: fetch original bytes, index extracted text.
 * Reuses the existing Caddington knowledge indexer — no separate search index.
 */

import type { McpEnvironment } from "@infra/shared";
import type { Env } from "../../env";
import { resolveMcpFetcher } from "../mcp-client";
import { resolveMcpAdminAuthHeader } from "../mcp-admin-bridge";

function adminAuthHeader(env: Env, mcp: McpEnvironment): string | null {
  return resolveMcpAdminAuthHeader(env, mcp).authorizationHeader;
}

async function adminFetch(
  env: Env,
  mcp: McpEnvironment,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const auth = adminAuthHeader(env, mcp);
  if (!auth) {
    throw new Error("MCP admin bridge token is not configured on infra-api");
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

export type KnowledgeDocumentAdminView = {
  ok: boolean;
  documentId: number;
  title: string | null;
  status: string | null;
  mimeType: string | null;
  externalId: string | null;
  byteSize: number | null;
  metadata: Record<string, unknown>;
};

export async function getKnowledgeDocumentAdmin(
  env: Env,
  mcp: McpEnvironment,
  documentId: number,
): Promise<KnowledgeDocumentAdminView | null> {
  const response = await adminFetch(env, mcp, `/admin/knowledge/${documentId}`, { method: "GET" });
  if (response.status === 404) return null;
  const body = (await response.json().catch(() => ({}))) as KnowledgeDocumentAdminView;
  if (!response.ok || !body.ok) return null;
  return body;
}

export async function getKnowledgeDocumentBytes(
  env: Env,
  mcp: McpEnvironment,
  documentId: number,
): Promise<{ bytes: ArrayBuffer; mimeType: string | null } | null> {
  const response = await adminFetch(env, mcp, `/admin/knowledge/${documentId}/content`, {
    method: "GET",
  });
  if (!response.ok) return null;
  return {
    bytes: await response.arrayBuffer(),
    mimeType: response.headers.get("Content-Type"),
  };
}

export async function indexExtractedKnowledgeText(
  env: Env,
  mcp: McpEnvironment,
  documentId: number,
  input: {
    text: string;
    ocrMetadata: Record<string, unknown>;
    fingerprint: string;
  },
): Promise<
  | { ok: true; chunksIndexed?: number; documentStatus?: string }
  | { ok: false; message: string }
> {
  const response = await adminFetch(env, mcp, `/admin/knowledge/${documentId}/index-extracted`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: input.text,
      fingerprint: input.fingerprint,
      metadata: input.ocrMetadata,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    chunksIndexed?: number;
    documentStatus?: string;
    partial?: boolean;
  };
  if (!response.ok || body.ok === false) {
    return { ok: false, message: body.error ?? `Index-extracted HTTP ${response.status}` };
  }

  if (body.partial) {
    const { indexKnowledgeDocumentUntilComplete } = await import("../microsoft-knowledge-bridge");
    const continued = await indexKnowledgeDocumentUntilComplete(env, mcp, documentId);
    if (!continued.ok) {
      return { ok: false, message: continued.message };
    }
    return {
      ok: true,
      chunksIndexed: continued.chunksIndexed,
      documentStatus: continued.documentStatus,
    };
  }

  return {
    ok: true,
    chunksIndexed: body.chunksIndexed,
    documentStatus: body.documentStatus ?? "indexed",
  };
}
