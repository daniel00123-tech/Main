import type { ParsedQuery } from "./query-parse";
import type { QueryRouting } from "./routing";
import { containsPhrase } from "./query-parse";
import type { ChunkSearchRecord } from "../knowledge/metadata";

export const RRF_K = 60;
export const MAX_CHUNKS_PER_DOCUMENT_DEFAULT = 3;

export type ResultConfidence = "strong" | "plausible" | "weak";

export interface RankedCandidate {
  key: string;
  chunkId: number;
  documentId: number;
  chunkIndex: number;
  record?: ChunkSearchRecord;
  semanticScore?: number;
  semanticRank?: number;
  lexicalBm25?: number;
  lexicalRank?: number;
  documentStageRank?: number;
  rrfScore: number;
  entityBoost: number;
  contextBoost: number;
  exactMatchBoost: number;
  routingBoost: number;
  versionBoost: number;
  documentStageBoost: number;
  finalScore: number;
  confidence: ResultConfidence;
}

export interface RankingSignals {
  finalScore: number;
  semanticScore?: number;
  semanticRank?: number;
  lexicalRank?: number;
  lexicalBm25?: number;
  documentStageRank?: number;
  entityBoost: number;
  contextBoost: number;
  exactMatchBoost: number;
  routingBoost: number;
  versionBoost: number;
  documentStageBoost: number;
  rrfScore: number;
}

export interface ScoreCandidateOptions {
  routing?: QueryRouting;
  documentStageRank?: number;
}

export function candidateKey(chunkId: number): string {
  return `chunk:${chunkId}`;
}

export function reciprocalRankFusion(
  lists: Array<Array<{ key: string; rank: number }>>
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (const item of list) {
      const add = 1 / (RRF_K + item.rank);
      scores.set(item.key, (scores.get(item.key) ?? 0) + add);
    }
  }
  return scores;
}

export function scoreCandidate(
  record: ChunkSearchRecord,
  parsed: ParsedQuery,
  semanticScore?: number,
  rrfScore = 0,
  options?: ScoreCandidateOptions
): RankedCandidate {
  const searchableBlob = [
    record.content,
    record.title,
    record.filename,
    record.externalId,
    record.heading,
    record.section,
    record.project,
    record.company,
    record.category,
    record.topic,
    record.department,
    record.property,
    record.source,
  ]
    .join("\n")
    .toLowerCase();

  const contextBlob = [
    record.title,
    record.filename,
    record.externalId,
    record.project,
    record.company,
    record.category,
    record.topic,
    record.department,
    record.property,
  ]
    .join(" ")
    .toLowerCase();

  let entityBoost = 0;
  for (const phrase of parsed.phrases) {
    if (containsPhrase(searchableBlob, phrase)) entityBoost += 0.12;
  }
  for (const phrase of parsed.titleCasePhrases) {
    if (containsPhrase(contextBlob, phrase)) entityBoost += 0.1;
  }
  entityBoost = Math.min(entityBoost, 0.45);

  let contextBoost = 0;
  for (const phrase of parsed.phrases) {
    if (containsPhrase(contextBlob, phrase)) contextBoost += 0.15;
  }
  for (const phrase of parsed.titleCasePhrases) {
    if (containsPhrase(contextBlob, phrase)) contextBoost += 0.12;
  }
  contextBoost = Math.min(contextBoost, 0.35);

  let exactMatchBoost = 0;
  for (const postcode of parsed.postcodes) {
    if (searchableBlob.includes(postcode.toLowerCase())) exactMatchBoost += 0.2;
  }
  for (const money of parsed.monetaryValues) {
    const normalizedMoney = money.replace(/\s/g, "").toLowerCase();
    if (searchableBlob.replace(/\s/g, "").includes(normalizedMoney)) {
      exactMatchBoost += 0.2;
    }
  }
  for (const date of parsed.dates) {
    if (searchableBlob.includes(date.toLowerCase())) exactMatchBoost += 0.12;
  }
  for (const ref of parsed.referenceNumbers) {
    if (searchableBlob.includes(ref)) exactMatchBoost += 0.2;
  }
  for (const phrase of parsed.phrases) {
    if (containsPhrase(record.content, phrase)) exactMatchBoost += 0.15;
  }
  exactMatchBoost = Math.min(exactMatchBoost, 0.55);

  let routingBoost = 0;
  const routing = options?.routing;
  if (routing) {
    for (const term of routing.boostTerms) {
      if (term.length >= 3 && searchableBlob.includes(term.toLowerCase())) {
        routingBoost += 0.035;
      }
    }
    for (const topic of routing.topics) {
      if (
        containsPhrase(contextBlob, topic) ||
        containsPhrase(record.category, topic) ||
        containsPhrase(record.topic, topic)
      ) {
        routingBoost += 0.08;
      }
    }
    for (const category of routing.likelyCategories) {
      if (containsPhrase(record.category, category)) routingBoost += 0.06;
    }
  }
  routingBoost = Math.min(routingBoost, 0.3);

  let versionBoost = 0;
  if (record.isCurrent) {
    versionBoost += 0.12;
  } else if (record.isCurrent === false && !routing?.asksHistorical) {
    versionBoost -= 0.06;
  }

  let documentStageBoost = 0;
  const documentStageRank = options?.documentStageRank;
  if (documentStageRank) {
    documentStageBoost = (1 / (RRF_K + documentStageRank)) * 10;
  }

  const normalizedSemantic = semanticScore ?? 0;
  const finalScore =
    rrfScore * 12 +
    normalizedSemantic * 0.35 +
    entityBoost +
    contextBoost +
    exactMatchBoost +
    routingBoost +
    versionBoost +
    documentStageBoost;

  const confidence = classifyChunkConfidence(
    finalScore,
    normalizedSemantic,
    exactMatchBoost,
    contextBoost,
    routingBoost
  );

  return {
    key: candidateKey(record.chunkId),
    chunkId: record.chunkId,
    documentId: record.documentId,
    chunkIndex: record.chunkIndex,
    record,
    semanticScore,
    rrfScore,
    entityBoost,
    contextBoost,
    exactMatchBoost,
    routingBoost,
    versionBoost,
    documentStageBoost,
    documentStageRank,
    finalScore,
    confidence,
  };
}

export function classifyChunkConfidence(
  finalScore: number,
  semanticScore: number,
  exactMatchBoost: number,
  contextBoost: number,
  routingBoost = 0
): ResultConfidence {
  if (
    finalScore >= 1.2 &&
    (semanticScore >= 0.45 || exactMatchBoost >= 0.15 || routingBoost >= 0.1)
  ) {
    return "strong";
  }
  if (
    finalScore >= 0.75 ||
    exactMatchBoost >= 0.15 ||
    contextBoost >= 0.15 ||
    routingBoost >= 0.1 ||
    semanticScore >= 0.55
  ) {
    return "plausible";
  }
  return "weak";
}

export function classifyOverallConfidence(
  ranked: RankedCandidate[],
  topK: number
): ResultConfidence {
  void topK;
  if (ranked.length === 0) return "weak";
  const top = ranked[0];
  const second = ranked[1];
  const gap = second ? top.finalScore - second.finalScore : top.finalScore;

  if (top.confidence === "strong" && gap >= 0.08) return "strong";
  if (top.confidence === "weak" && gap < 0.05) return "weak";
  if (top.confidence === "strong" || top.confidence === "plausible") {
    return gap >= 0.04 ? "plausible" : "weak";
  }
  return "weak";
}

export function applyResultDiversity(
  ranked: RankedCandidate[],
  topK: number,
  maxPerDocument = MAX_CHUNKS_PER_DOCUMENT_DEFAULT
): RankedCandidate[] {
  const selected: RankedCandidate[] = [];
  const perDocument = new Map<number, number>();
  const bestScore = ranked[0]?.finalScore ?? 0;

  for (const candidate of ranked) {
    const count = perDocument.get(candidate.documentId) ?? 0;
    const nearTop = candidate.finalScore >= bestScore * 0.88;
    if (count >= maxPerDocument && !nearTop) continue;
    selected.push(candidate);
    perDocument.set(candidate.documentId, count + 1);
    if (selected.length >= topK) break;
  }

  return selected;
}

export function toRankingSignals(candidate: RankedCandidate): RankingSignals {
  return {
    finalScore: candidate.finalScore,
    semanticScore: candidate.semanticScore,
    semanticRank: candidate.semanticRank,
    lexicalRank: candidate.lexicalRank,
    lexicalBm25: candidate.lexicalBm25,
    documentStageRank: candidate.documentStageRank,
    entityBoost: candidate.entityBoost,
    contextBoost: candidate.contextBoost,
    exactMatchBoost: candidate.exactMatchBoost,
    routingBoost: candidate.routingBoost,
    versionBoost: candidate.versionBoost,
    documentStageBoost: candidate.documentStageBoost,
    rrfScore: candidate.rrfScore,
  };
}
