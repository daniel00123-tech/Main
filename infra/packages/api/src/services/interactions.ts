import { newId } from "../db/mappers";

/**
 * Server-side interaction grouping for one human AI turn.
 *
 * ChatGPT JSON-RPC ids MUST NOT be used — they are reused (often `0`).
 * We never infer a group from the user's prompt text.
 *
 * Clients may send:
 *   Header  X-Infra-Interaction-Id
 *   Body    params._meta.interactionId  or  params.interactionId
 *
 * If none is provided, we generate a fresh interaction id for this operation
 * so the column is populated going forward. We do not guess that two nearby
 * calls belong to the same human request.
 */
export function resolveInteractionIds(input: {
  headerInteractionId?: string | null;
  metaInteractionId?: string | null;
  bodyInteractionId?: string | null;
  parentRequestId?: string | null;
  mcpSessionId?: string | null;
}): {
  interactionId: string;
  parentRequestId: string | null;
  mcpSessionId: string | null;
  sourcedFrom: "client" | "generated";
} {
  const client =
    cleanId(input.headerInteractionId) ??
    cleanId(input.metaInteractionId) ??
    cleanId(input.bodyInteractionId);

  return {
    interactionId: client ?? newId("int"),
    parentRequestId: cleanId(input.parentRequestId),
    mcpSessionId: cleanId(input.mcpSessionId),
    sourcedFrom: client ? "client" : "generated",
  };
}

function cleanId(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return null;
  if (trimmed === "0") return null;
  return trimmed;
}
