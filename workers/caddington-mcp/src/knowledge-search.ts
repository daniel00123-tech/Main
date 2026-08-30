import {
  SEARCH_DEFAULT_TOP_K,
  SEARCH_DOCUMENT_CANDIDATE_MAX,
  SEARCH_LEXICAL_CANDIDATE_MAX,
  SEARCH_MAX_TOP_K,
  SEARCH_RERANK_POOL_MAX,
  SEARCH_VECTOR_CANDIDATE_MAX,
  SEARCH_VECTOR_CANDIDATE_MIN,
} from "./constants";
import { buildSearchGuidance } from "./caddington-usage";
import type { Env } from "./db";
import type { SegmentMetadata } from "./document-segments";
import { vectorFieldsToSegmentMetadata } from "./document-segments";
import { embedText } from "./knowledge-embed";
import {
  lexicalSearchChunks,
  lexicalSearchDocuments,
  loadChunkSearchRecords,
  loadNeighbourChunkContent,
} from "./knowledge-fts";
import {
  getFilteredDocumentIds,
  provenanceFromRecord,
  type ChunkSearchRecord,
  type KnowledgeSearchFilters,
  type SearchProvenance,
} from "./knowledge-metadata";
import { buildFtsMatchQuery, parseSearchQuery } from "./knowledge-query";
import { routeSearchQuery } from "./knowledge-query-routing";
import {
  applyResultDiversity,
  classifyOverallConfidence,
  candidateKey,
  reciprocalRankFusion,
  scoreCandidate,
  toRankingSignals,
  type RankedCandidate,
  type ResultConfidence,
} from "./knowledge-ranking";
import {
  buildSearchCacheKey,
  getKnowledgeIndexGeneration,
  readSearchCache,
  writeSearchCache,
} from "./knowledge-search-cache";

export interface KnowledgeSearchRanking {
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

export interface KnowledgeSearchResult {
  score: number;
  documentId: number;
  externalId: string;
  filename?: string;
  title: string;
  documentType?: string;
  chunkId: number;
  chunkIndex: number;
  chunkNumber?: number;
  snippet: string;
  content?: string;
  page?: number;
  sheet?: string;
  slide?: number;
  section?: string;
  heading?: string;
  company?: string;
  project?: string;
  category?: string;
  topic?: string;
  department?: string;
  property?: string;
  documentDate?: string;
  source?: string;
  metadata?: SegmentMetadata;
  provenance?: SearchProvenance;
  confidence?: ResultConfidence;
  ranking?: KnowledgeSearchRanking;
  contextBefore?: string;
  contextAfter?: string;
}

export interface KnowledgeSearchDiagnostics {
  latencyMs: number;
  queryProcessingMs: number;
  embeddingMs: number;
  vectorSearchMs: number;
  lexicalSearchMs: number;
  documentStageMs: number;
  fusionRerankMs: number;
  vectorCandidates: number;
  lexicalCandidates: number;
  documentCandidates: number;
  rerankedCandidates: number;
  fusedCandidates: number;
  finalReturned: number;
  cacheHit: boolean;
  indexGeneration?: string;
}

export interface KnowledgeSearchResponse {
  query: string;
  parsedQuery?: {
    phrases: string[];
    postcodes: string[];
    monetaryValues: string[];
    dates: string[];
    referenceNumbers: string[];
    distinctiveTerms: string[];
  };
  routing?: {
    topics: string[];
    intents: string[];
    boostTerms: string[];
    likelyCategories: string[];
    asksHistorical: boolean;
  };
  confidence: ResultConfidence;
  resultCount: number;
  results: KnowledgeSearchResult[];
  guidance?: string;
  diagnostics?: KnowledgeSearchDiagnostics;
}

export interface KnowledgeSearchOptions {
  topK?: number;
  filters?: KnowledgeSearchFilters;
  includeNeighbourContext?: boolean;
  includeDiagnostics?: boolean;
  includeFullContent?: boolean;
  skipCache?: boolean;
}

function recordToSearchResult(
  record: ChunkSearchRecord,
  candidate: RankedCandidate,
  options: KnowledgeSearchOptions
): KnowledgeSearchResult {
  const result: KnowledgeSearchResult = {
    score: candidate.finalScore,
    documentId: record.documentId,
    externalId: record.externalId,
    filename: record.filename,
    title: record.title,
    documentType: record.documentType,
    chunkId: record.chunkId,
    chunkIndex: record.chunkIndex,
    chunkNumber: record.chunkNumber ?? record.chunkIndex,
    snippet: record.content.slice(0, 280),
    page: record.page,
    sheet: record.sheet,
    slide: record.slide,
    section: record.section || undefined,
    heading: record.heading || undefined,
    company: record.company || undefined,
    project: record.project || undefined,
    category: record.category || undefined,
    topic: record.topic || undefined,
    department: record.department || undefined,
    property: record.property || undefined,
    documentDate: record.documentDate || undefined,
    source: record.source || undefined,
    provenance: provenanceFromRecord(record),
    confidence: candidate.confidence,
    ranking: toRankingSignals(candidate),
  };

  if (options.includeFullContent) {
    result.content = record.content;
  }

  return result;
}

export async function searchCompanyKnowledgeHybrid(
  env: Env,
  query: string,
  options: KnowledgeSearchOptions = {}
): Promise<KnowledgeSearchResponse> {
  const started = Date.now();
  const topK = Math.min(
    options.topK ?? SEARCH_DEFAULT_TOP_K,
    SEARCH_MAX_TOP_K
  );

  if (!env.CADDINGTON_KNOWLEDGE_INDEX) {
    throw new Error(
      "Vectorize index is not available. Enable Vectorize and redeploy with bindings."
    );
  }

  const indexGeneration = await getKnowledgeIndexGeneration(env);
  const cacheKey = buildSearchCacheKey(query, {
    topK,
    filters: options.filters,
    includeNeighbourContext: options.includeNeighbourContext ?? false,
    includeFullContent: options.includeFullContent ?? false,
  });

  if (!options.skipCache) {
    const cached = readSearchCache(cacheKey, indexGeneration);
    if (cached) {
      if (options.includeDiagnostics) {
        cached.diagnostics = {
          latencyMs: Date.now() - started,
          queryProcessingMs: 0,
          embeddingMs: 0,
          vectorSearchMs: 0,
          lexicalSearchMs: 0,
          documentStageMs: 0,
          fusionRerankMs: 0,
          vectorCandidates: 0,
          lexicalCandidates: 0,
          documentCandidates: 0,
          rerankedCandidates: 0,
          fusedCandidates: 0,
          finalReturned: cached.resultCount,
          cacheHit: true,
          indexGeneration,
        };
      }
      return cached;
    }
  }

  const parseStarted = Date.now();
  const parsed = parseSearchQuery(query);
  const routing = routeSearchQuery(parsed);
  const queryProcessingMs = Date.now() - parseStarted;

  const allowedDocumentIds = await getFilteredDocumentIds(env, options.filters);
  if (allowedDocumentIds && allowedDocumentIds.length === 0) {
    return emptyResponse(query, parsed, routing, started, options, indexGeneration);
  }

  const vectorCandidateCount = Math.min(
    SEARCH_VECTOR_CANDIDATE_MAX,
    Math.max(SEARCH_VECTOR_CANDIDATE_MIN, topK * 5)
  );

  const ftsQuery = buildFtsMatchQuery(parsed);

  const embedStarted = Date.now();
  const vector = await embedText(env, parsed.normalized || query);
  const embeddingMs = Date.now() - embedStarted;

  const vectorStarted = Date.now();
  const vectorPromise = env.CADDINGTON_KNOWLEDGE_INDEX.query(vector, {
    topK: vectorCandidateCount,
    returnMetadata: "all",
  });

  const lexicalPromise = ftsQuery
    ? lexicalSearchChunks(
        env,
        ftsQuery,
        allowedDocumentIds,
        SEARCH_LEXICAL_CANDIDATE_MAX
      )
    : Promise.resolve([]);

  const documentPromise = ftsQuery
    ? lexicalSearchDocuments(env, ftsQuery, SEARCH_DOCUMENT_CANDIDATE_MAX)
    : Promise.resolve([]);

  const [vectorMatches, lexicalHits, documentHits] = await Promise.all([
    vectorPromise,
    lexicalPromise,
    documentPromise,
  ]);
  const vectorSearchMs = Date.now() - vectorStarted;
  const lexicalSearchMs = 0;
  const documentStageMs = 0;

  const documentStageRankById = new Map<number, number>();
  for (let i = 0; i < documentHits.length; i++) {
    documentStageRankById.set(documentHits[i].documentId, i + 1);
  }

  const semanticRanked: Array<{ key: string; rank: number; score: number }> = [];
  const semanticByKey = new Map<string, number>();
  let semanticRank = 1;
  for (const match of vectorMatches.matches) {
    const meta = match.metadata ?? {};
    const chunkId = Number(meta.chunk_id ?? 0);
    if (!chunkId) continue;
    if (
      allowedDocumentIds &&
      !allowedDocumentIds.includes(Number(meta.document_id ?? 0))
    ) {
      continue;
    }
    const key = candidateKey(chunkId);
    if (semanticByKey.has(key)) continue;
    semanticByKey.set(key, match.score ?? 0);
    semanticRanked.push({ key, rank: semanticRank, score: match.score ?? 0 });
    semanticRank++;
  }

  const lexicalRanked: Array<{ key: string; rank: number; bm25: number }> = [];
  const lexicalByKey = new Map<string, number>();
  for (let i = 0; i < lexicalHits.length; i++) {
    const hit = lexicalHits[i];
    const key = candidateKey(hit.chunkId);
    if (lexicalByKey.has(key)) continue;
    lexicalByKey.set(key, hit.bm25);
    lexicalRanked.push({ key, rank: i + 1, bm25: hit.bm25 });
  }

  const fusionStarted = Date.now();
  const fusedScores = reciprocalRankFusion([
    semanticRanked.map((item) => ({ key: item.key, rank: item.rank })),
    lexicalRanked.map((item) => ({ key: item.key, rank: item.rank })),
  ]);

  const candidateChunkIds = [...fusedScores.keys()].map((key) =>
    Number(key.replace("chunk:", ""))
  );

  const recordMap = await loadChunkSearchRecords(
    env,
    candidateChunkIds.slice(0, SEARCH_RERANK_POOL_MAX)
  );

  const rankedCandidates: RankedCandidate[] = [];
  for (const [key, rrfScore] of fusedScores.entries()) {
    const chunkId = Number(key.replace("chunk:", ""));
    const record = recordMap.get(chunkId);
    if (!record) continue;

    const semanticRankEntry = semanticRanked.find((item) => item.key === key);
    const lexicalRankEntry = lexicalRanked.find((item) => item.key === key);
    const documentStageRank = documentStageRankById.get(record.documentId);

    const candidate = scoreCandidate(
      record,
      parsed,
      semanticByKey.get(key),
      rrfScore,
      { routing, documentStageRank }
    );
    candidate.semanticRank = semanticRankEntry?.rank;
    candidate.lexicalRank = lexicalRankEntry?.rank;
    candidate.lexicalBm25 = lexicalByKey.get(key);
    rankedCandidates.push(candidate);
  }

  rankedCandidates.sort((a, b) => b.finalScore - a.finalScore);
  const diversified = applyResultDiversity(rankedCandidates, topK);
  const overallConfidence = classifyOverallConfidence(rankedCandidates, topK);
  const fusionRerankMs = Date.now() - fusionStarted;

  const results: KnowledgeSearchResult[] = [];
  for (const candidate of diversified) {
    if (!candidate.record) continue;
    const result = recordToSearchResult(candidate.record, candidate, options);

    if (options.includeNeighbourContext) {
      const neighbours = await loadNeighbourChunkContent(
        env,
        candidate.documentId,
        candidate.chunkIndex
      );
      if (neighbours.before) result.contextBefore = neighbours.before;
      if (neighbours.after) result.contextAfter = neighbours.after;
    }

    const segmentMeta = vectorFieldsToSegmentMetadata({
      page: result.page,
      section: result.section,
      heading: result.heading,
      sheet: result.sheet,
      slide: result.slide,
      fileType: candidate.record.documentType,
      chunkNumber: result.chunkNumber,
    });
    if (Object.keys(segmentMeta).length > 0) {
      result.metadata = segmentMeta;
    }

    results.push(result);
  }

  const response: KnowledgeSearchResponse = {
    query,
    parsedQuery: summarizeParsedQuery(parsed),
    routing: {
      topics: routing.topics,
      intents: routing.intents,
      boostTerms: routing.boostTerms.slice(0, 20),
      likelyCategories: routing.likelyCategories,
      asksHistorical: routing.asksHistorical,
    },
    confidence: overallConfidence,
    resultCount: results.length,
    results,
    guidance: buildSearchGuidance(overallConfidence, results.length),
    diagnostics: options.includeDiagnostics
      ? {
          latencyMs: Date.now() - started,
          queryProcessingMs,
          embeddingMs,
          vectorSearchMs,
          lexicalSearchMs,
          documentStageMs,
          fusionRerankMs,
          vectorCandidates: semanticRanked.length,
          lexicalCandidates: lexicalHits.length,
          documentCandidates: documentHits.length,
          rerankedCandidates: rankedCandidates.length,
          fusedCandidates: fusedScores.size,
          finalReturned: results.length,
          cacheHit: false,
          indexGeneration,
        }
      : undefined,
  };

  if (!options.skipCache) {
    writeSearchCache(cacheKey, indexGeneration, response);
  }

  return response;
}

function summarizeParsedQuery(
  parsed: ReturnType<typeof parseSearchQuery>
): KnowledgeSearchResponse["parsedQuery"] {
  return {
    phrases: parsed.phrases,
    postcodes: parsed.postcodes,
    monetaryValues: parsed.monetaryValues,
    dates: parsed.dates,
    referenceNumbers: parsed.referenceNumbers,
    distinctiveTerms: parsed.distinctiveTerms,
  };
}

function emptyResponse(
  query: string,
  parsed: ReturnType<typeof parseSearchQuery>,
  routing: ReturnType<typeof routeSearchQuery>,
  started: number,
  options: KnowledgeSearchOptions,
  indexGeneration: string
): KnowledgeSearchResponse {
  return {
    query,
    parsedQuery: summarizeParsedQuery(parsed),
    routing: {
      topics: routing.topics,
      intents: routing.intents,
      boostTerms: routing.boostTerms.slice(0, 20),
      likelyCategories: routing.likelyCategories,
      asksHistorical: routing.asksHistorical,
    },
    confidence: "weak",
    resultCount: 0,
    results: [],
    guidance: buildSearchGuidance("weak", 0),
    diagnostics: options.includeDiagnostics
      ? {
          latencyMs: Date.now() - started,
          queryProcessingMs: 0,
          embeddingMs: 0,
          vectorSearchMs: 0,
          lexicalSearchMs: 0,
          documentStageMs: 0,
          fusionRerankMs: 0,
          vectorCandidates: 0,
          lexicalCandidates: 0,
          documentCandidates: 0,
          rerankedCandidates: 0,
          fusedCandidates: 0,
          finalReturned: 0,
          cacheHit: false,
          indexGeneration,
        }
      : undefined,
  };
}
