import {
  SEARCH_LEXICAL_CANDIDATE_MAX,
  SEARCH_RERANK_POOL_MAX,
  SEARCH_VECTOR_CANDIDATE_MAX,
  SEARCH_VECTOR_CANDIDATE_MIN,
} from "./constants";
import type { Env } from "./db";
import {
  documentMatchesFilters,
  type ChunkSearchRecord,
  type KnowledgeSearchFilters,
} from "./knowledge-metadata";
import {
  lexicalSearchChunks,
  loadChunkSearchRecords,
  loadNeighbourChunkContent,
} from "./knowledge-fts";
import { buildFtsMatchQuery, parseSearchQuery } from "./knowledge-query";
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
import { embedText } from "./knowledge-embed";
import type { SegmentMetadata } from "./document-segments";
import { vectorFieldsToSegmentMetadata } from "./document-segments";

export interface KnowledgeSearchRanking {
  finalScore: number;
  semanticScore?: number;
  semanticRank?: number;
  lexicalRank?: number;
  lexicalBm25?: number;
  entityBoost: number;
  contextBoost: number;
  exactMatchBoost: number;
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
  documentDate?: string;
  source?: string;
  metadata?: SegmentMetadata;
  confidence?: ResultConfidence;
  ranking?: KnowledgeSearchRanking;
  contextBefore?: string;
  contextAfter?: string;
}

export interface KnowledgeSearchDiagnostics {
  latencyMs: number;
  vectorCandidates: number;
  lexicalCandidates: number;
  rerankedCandidates: number;
  fusedCandidates: number;
  finalReturned: number;
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
  confidence: ResultConfidence;
  resultCount: number;
  results: KnowledgeSearchResult[];
  diagnostics?: KnowledgeSearchDiagnostics;
}

export interface KnowledgeSearchOptions {
  topK?: number;
  filters?: KnowledgeSearchFilters;
  includeNeighbourContext?: boolean;
  includeDiagnostics?: boolean;
  includeFullContent?: boolean;
}

async function getFilteredDocumentIds(
  env: Env,
  filters?: KnowledgeSearchFilters
): Promise<number[] | null> {
  if (!filters || Object.keys(filters).length === 0) return null;

  const rows = await env.CADDINGTON_BUSINESS_DATA.prepare(
    `SELECT id, title, metadata, mime_type, r2_key
     FROM knowledge_documents
     WHERE status = 'indexed'`
  ).all();

  const ids: number[] = [];
  for (const row of rows.results) {
    const record = row as Record<string, unknown>;
    if (
      documentMatchesFilters(
        {
          title: String(record.title),
          metadata: record.metadata as string | null,
          mime_type: record.mime_type as string | null,
          r2_key: record.r2_key as string,
        },
        filters
      )
    ) {
      ids.push(Number(record.id));
    }
  }
  return ids;
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
    documentDate: record.documentDate || undefined,
    source: record.source || undefined,
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
  const topK = options.topK ?? 5;

  if (!env.CADDINGTON_KNOWLEDGE_INDEX) {
    throw new Error(
      "Vectorize index is not available. Enable Vectorize and redeploy with bindings."
    );
  }

  const parsed = parseSearchQuery(query);
  const allowedDocumentIds = await getFilteredDocumentIds(env, options.filters);
  if (allowedDocumentIds && allowedDocumentIds.length === 0) {
    return {
      query,
      parsedQuery: summarizeParsedQuery(parsed),
      confidence: "weak",
      resultCount: 0,
      results: [],
      diagnostics: options.includeDiagnostics
        ? {
            latencyMs: Date.now() - started,
            vectorCandidates: 0,
            lexicalCandidates: 0,
            rerankedCandidates: 0,
            fusedCandidates: 0,
            finalReturned: 0,
          }
        : undefined,
    };
  }

  const vectorCandidateCount = Math.min(
    SEARCH_VECTOR_CANDIDATE_MAX,
    Math.max(SEARCH_VECTOR_CANDIDATE_MIN, topK * 6)
  );

  const vector = await embedText(env, parsed.normalized || query);
  const vectorMatches = await env.CADDINGTON_KNOWLEDGE_INDEX.query(vector, {
    topK: vectorCandidateCount,
    returnMetadata: "all",
  });

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

  const ftsQuery = buildFtsMatchQuery(parsed);
  const lexicalHits = ftsQuery
    ? await lexicalSearchChunks(
        env,
        ftsQuery,
        allowedDocumentIds,
        SEARCH_LEXICAL_CANDIDATE_MAX
      )
    : [];

  const lexicalRanked: Array<{ key: string; rank: number; bm25: number }> = [];
  const lexicalByKey = new Map<string, number>();
  for (let i = 0; i < lexicalHits.length; i++) {
    const hit = lexicalHits[i];
    const key = candidateKey(hit.chunkId);
    if (lexicalByKey.has(key)) continue;
    lexicalByKey.set(key, hit.bm25);
    lexicalRanked.push({ key, rank: i + 1, bm25: hit.bm25 });
  }

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
    const candidate = scoreCandidate(
      record,
      parsed,
      semanticByKey.get(key),
      rrfScore
    );
    candidate.semanticRank = semanticRankEntry?.rank;
    candidate.lexicalRank = lexicalRankEntry?.rank;
    candidate.lexicalBm25 = lexicalByKey.get(key);
    rankedCandidates.push(candidate);
  }

  rankedCandidates.sort((a, b) => b.finalScore - a.finalScore);
  const diversified = applyResultDiversity(rankedCandidates, topK);
  const overallConfidence = classifyOverallConfidence(rankedCandidates, topK);

  const results: KnowledgeSearchResult[] = [];
  for (const candidate of diversified) {
    if (!candidate.record) continue;
    const result = recordToSearchResult(
      candidate.record,
      candidate,
      options
    );

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

  const latencyMs = Date.now() - started;
  return {
    query,
    parsedQuery: summarizeParsedQuery(parsed),
    confidence: overallConfidence,
    resultCount: results.length,
    results,
    diagnostics: options.includeDiagnostics
      ? {
          latencyMs,
          vectorCandidates: semanticRanked.length,
          lexicalCandidates: lexicalHits.length,
          rerankedCandidates: rankedCandidates.length,
          fusedCandidates: fusedScores.size,
          finalReturned: results.length,
        }
      : undefined,
  };
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
