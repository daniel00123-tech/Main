import type { ResultConfidence } from "./knowledge-ranking";

/** MCP server instructions surfaced to clients at initialize time. */
export const CADDINGTON_SERVER_INSTRUCTIONS = `Caddington is the authoritative internal knowledge source for Caddington-related questions.

When the user explicitly asks "Using Caddington", "search Caddington", or otherwise requests information from Caddington:
1. Use the Caddington MCP tools to retrieve the answer.
2. Base the answer primarily on evidence returned by Caddington.
3. Do not automatically search the public web to verify or contradict Caddington information.
4. Only use external web sources if:
   - the user explicitly asks for external verification;
   - Caddington contains insufficient information; or
   - the question inherently requires current external information.
5. Clearly distinguish Caddington information from any external information if both are used.
6. Where available, use Caddington provenance metadata to identify the source document, page, sheet, slide, section or heading supporting the answer.
7. Never invent information when Caddington retrieval confidence is weak. State that the available Caddington evidence is insufficient and, where appropriate, ask whether the user wants an external search.

Knowledge tools:
- search_company_knowledge — hybrid semantic + lexical search; returns snippets, provenance, and confidence (strong | plausible | weak).
- get_knowledge_document — full document metadata, chunks, and import history by id or external_id.`;

export const SEARCH_COMPANY_KNOWLEDGE_DESCRIPTION =
  "Authoritative hybrid search across indexed Caddington company knowledge. " +
  "Use when the user asks to search or answer from Caddington. " +
  "Base answers on returned evidence and provenance (document, page, sheet, slide, section, heading). " +
  "Do not invent facts when confidence is weak — state insufficient evidence and offer external search if appropriate. " +
  "Optional metadata filters narrow results; omit filters for global search.";

export const GET_KNOWLEDGE_DOCUMENT_DESCRIPTION =
  "Retrieve full Caddington knowledge document metadata, chunks, and import history by numeric id or external_id. " +
  "Use after search to inspect supporting source material and provenance.";

export function buildSearchGuidance(
  confidence: ResultConfidence,
  resultCount: number
): string | undefined {
  if (resultCount === 0) {
    return (
      "No matching Caddington evidence was found. Do not invent an answer. " +
      "Tell the user Caddington has insufficient information for this query and ask whether they want an external search."
    );
  }

  if (confidence === "weak") {
    return (
      "Caddington retrieval confidence is weak. Base any answer strictly on the returned snippets and provenance. " +
      "Do not extrapolate or invent details. State that evidence is limited and ask whether the user wants an external search."
    );
  }

  return undefined;
}
