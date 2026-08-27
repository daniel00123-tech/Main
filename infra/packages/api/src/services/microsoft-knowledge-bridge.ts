/**
 * Push Microsoft documents into the company Business MCP knowledge corpus.
 * Reuses Caddington /admin/knowledge/upload + /admin/knowledge/{id}/index.
 */

import type { Env } from "../env";
import type { McpEnvironment } from "@infra/shared";
import { resolveMcpFetcher } from "./mcp-client";
import { resolveMcpAdminAuthHeader } from "./mcp-admin-bridge";

export type KnowledgeUploadResult =
  | { ok: true; documentId: number; externalId: string; indexed: boolean }
  | { ok: false; code: string; message: string };

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

function fnv1aHex(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Stable external id for Vectorize upsert — must stay within 64 bytes. */
export function buildMicrosoftExternalId(input: {
  sourceType: string;
  driveId: string;
  itemId: string;
}): string {
  const raw = `${input.sourceType}|${input.driveId}|${input.itemId}`;
  const prefix = input.sourceType === "sharepoint" ? "mssp" : "msod";
  return `${prefix}-${fnv1aHex(raw)}${fnv1aHex(`${raw}|salt`)}`;
}

/** Stable external id for Outlook mail messages and attachments. */
export function buildMicrosoftMailExternalId(input: {
  mailboxAddress: string;
  messageId: string;
  attachmentId?: string | null;
}): string {
  const raw = input.attachmentId
    ? `outlook_shared|${input.mailboxAddress}|${input.messageId}|${input.attachmentId}`
    : `outlook_shared|${input.mailboxAddress}|${input.messageId}`;
  const prefix = input.attachmentId ? "msat" : "msml";
  return `${prefix}-${fnv1aHex(raw)}${fnv1aHex(`${raw}|salt`)}`;
}

export function buildOutlookKnowledgeProvenance(input: {
  companyId: string;
  tenantId: string | null;
  mailboxAddress: string;
  folderName?: string | null;
  messageId: string;
  internetMessageId?: string | null;
  subject?: string | null;
  from?: string | null;
  to?: string[];
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  attachmentId?: string | null;
  attachmentName?: string | null;
}): Record<string, unknown> {
  return {
    connector: "microsoft_365",
    sourceType: "outlook_shared",
    companyId: input.companyId,
    tenantId: input.tenantId,
    mailboxAddress: input.mailboxAddress,
    folderName: input.folderName ?? "Inbox",
    messageId: input.messageId,
    internetMessageId: input.internetMessageId ?? null,
    subject: input.subject ?? null,
    from: input.from ?? null,
    to: input.to ?? [],
    receivedDateTime: input.receivedDateTime ?? null,
    sentDateTime: input.sentDateTime ?? null,
    attachmentId: input.attachmentId ?? null,
    attachmentName: input.attachmentName ?? null,
    sourceLabel: [
      "Microsoft 365",
      "Outlook",
      input.mailboxAddress,
      input.folderName ?? "Inbox",
      input.attachmentName ?? input.subject ?? input.messageId,
    ].join(" → "),
  };
}

export async function deactivateMicrosoftKnowledgeDocument(
  env: Env,
  mcp: McpEnvironment,
  documentId: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await adminFetch(env, mcp, `/admin/knowledge/${documentId}/deactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!response.ok || body.ok === false) {
      return { ok: false, message: body.error ?? `Deactivate HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Deactivate failed" };
  }
}

export async function reactivateMicrosoftKnowledgeDocument(
  env: Env,
  mcp: McpEnvironment,
  documentId: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await adminFetch(env, mcp, `/admin/knowledge/${documentId}/reactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!response.ok || body.ok === false) {
      return { ok: false, message: body.error ?? `Reactivate HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Reactivate failed" };
  }
}
