import type { IntelligenceConversationState, IntelligenceDocumentRef } from "./types.js";

const MAX_HISTORY_TURNS = 16;
const MAX_TURN_CHARS = 500;
const MAX_ENTITIES = 6;

export function buildConversationState(input: {
  userText: string;
  currentDocument?: IntelligenceDocumentRef | null;
  entities?: Array<IntelligenceDocumentRef & { type?: string }>;
  recentTurns?: Array<{ role: "user" | "assistant"; text: string }>;
}): IntelligenceConversationState {
  const currentDocument = compactDoc(input.currentDocument);
  const entities = (input.entities ?? [])
    .map((entity) => ({
      type: entity.type ?? "document",
      id: entity.id.slice(0, 180),
      title: entity.title.slice(0, 180),
      url: entity.url ?? null,
    }))
    .filter((entity) => entity.id && entity.title)
    .slice(0, MAX_ENTITIES);
  if (currentDocument && !entities.some((entity) => entity.id === currentDocument.id)) {
    entities.unshift({
      type: "document",
      id: currentDocument.id,
      title: currentDocument.title,
      url: currentDocument.url ?? null,
    });
  }
  return {
    entities,
    currentDocument,
    recentTurns: (input.recentTurns ?? [])
      .filter((turn) => turn.text.trim())
      .slice(-MAX_HISTORY_TURNS)
      .map((turn) => ({ role: turn.role, text: turn.text.slice(0, MAX_TURN_CHARS) })),
    lastUserText: input.userText.slice(0, 1_200),
  };
}

export function formatConversationState(state: IntelligenceConversationState): string {
  const current = state.currentDocument
    ? `${state.currentDocument.title} (id=${state.currentDocument.id}${state.currentDocument.url ? `; url=${state.currentDocument.url}` : ""})`
    : "none";
  const entities = state.entities.length
    ? state.entities.map((entity) => `${entity.type}:${entity.title} (${entity.id})`).join("; ")
    : "none";
  const history = state.recentTurns.length
    ? state.recentTurns.map((turn) => `${turn.role}: ${turn.text}`).join("\n")
    : "none";
  return [
    `Current document: ${current}`,
    `Known entities: ${entities}`,
    `Recent turns:\n${history}`,
    `User: ${state.lastUserText}`,
  ].join("\n");
}

function compactDoc(doc?: IntelligenceDocumentRef | null): IntelligenceDocumentRef | null {
  if (!doc?.id || !doc.title) return null;
  return {
    id: doc.id.slice(0, 180),
    title: doc.title.slice(0, 180),
    url: doc.url ?? null,
    source: doc.source ?? null,
  };
}
