import { describe, expect, it } from "vitest";
import { buildFtsMatchQuery, parseSearchQuery } from "../src/knowledge-query";
import {
  applyResultDiversity,
  reciprocalRankFusion,
  scoreCandidate,
} from "../src/knowledge-ranking";
import type { ChunkSearchRecord } from "../src/knowledge-metadata";

describe("parseSearchQuery", () => {
  it("extracts project phrases, money and postcodes", () => {
    const parsed = parseSearchQuery(
      "What is the maximum spend without approval for Project Falcon? HP27 9AU £317,450"
    );
    expect(parsed.phrases.some((p) => p.includes("Project Falcon"))).toBe(true);
    expect(parsed.postcodes).toContain("HP27 9AU");
    expect(parsed.monetaryValues.some((v) => v.includes("317,450"))).toBe(true);
    expect(buildFtsMatchQuery(parsed)).toBeTruthy();
  });
});

describe("hybrid ranking", () => {
  const falconRecord: ChunkSearchRecord = {
    chunkId: 10,
    documentId: 5,
    chunkIndex: 1,
    content:
      "Project Name: Project Falcon\nApproved Budget: £317,450\nMaximum Spend Without Approval: £1,275",
    title: "Project Falcon Image Test",
    externalId: "upload-project-falcon-jpeg",
    filename: "project-falcon-test.jpg",
    heading: "Document Content",
    section: "Document Content",
    project: "Project Falcon",
    company: "",
    category: "",
    topic: "",
    department: "",
    property: "",
    person: "",
    customer: "",
    supplier: "",
    documentType: "image",
    source: "",
    documentDate: "",
    chunkNumber: 1,
  };

  const troutRecord: ChunkSearchRecord = {
    chunkId: 20,
    documentId: 3,
    chunkIndex: 15,
    content:
      "Responsible for payment of the fee quoted prior to the survey being booked.",
    title: "Trout Hollow Survey",
    externalId: "upload-trout-hollow-968e",
    filename: "5_Trout_Hollow.pdf",
    heading: "Page 4",
    section: "Page 4",
    project: "",
    company: "",
    category: "",
    topic: "",
    department: "",
    property: "Trout Hollow",
    person: "",
    customer: "",
    supplier: "",
    documentType: "pdf",
    source: "",
    documentDate: "",
    chunkNumber: 15,
  };

  it("boosts Project Falcon chunk for project-specific query", () => {
    const parsed = parseSearchQuery(
      "What is the maximum spend without approval for Project Falcon?"
    );
    const falcon = scoreCandidate(falconRecord, parsed, 0.55, 0.03);
    const trout = scoreCandidate(troutRecord, parsed, 0.68, 0.02);
    expect(falcon.finalScore).toBeGreaterThan(trout.finalScore);
  });

  it("fuses semantic and lexical ranks with RRF", () => {
    const fused = reciprocalRankFusion([
      [
        { key: "chunk:10", rank: 2 },
        { key: "chunk:20", rank: 1 },
      ],
      [
        { key: "chunk:10", rank: 1 },
        { key: "chunk:20", rank: 3 },
      ],
    ]);
    expect(fused.get("chunk:10")).toBeGreaterThan(fused.get("chunk:20") ?? 0);
  });

  it("limits chunks per document while keeping near-top repeats", () => {
    const ranked = [
      { documentId: 1, chunkIndex: 0, finalScore: 2.0, confidence: "strong" as const, key: "a", chunkId: 1, rrfScore: 1, entityBoost: 0, contextBoost: 0, exactMatchBoost: 0, routingBoost: 0, versionBoost: 0, documentStageBoost: 0 },
      { documentId: 1, chunkIndex: 1, finalScore: 1.9, confidence: "strong" as const, key: "b", chunkId: 2, rrfScore: 1, entityBoost: 0, contextBoost: 0, exactMatchBoost: 0, routingBoost: 0, versionBoost: 0, documentStageBoost: 0 },
      { documentId: 1, chunkIndex: 2, finalScore: 1.8, confidence: "plausible" as const, key: "c", chunkId: 3, rrfScore: 1, entityBoost: 0, contextBoost: 0, exactMatchBoost: 0, routingBoost: 0, versionBoost: 0, documentStageBoost: 0 },
      { documentId: 1, chunkIndex: 3, finalScore: 1.0, confidence: "weak" as const, key: "d", chunkId: 4, rrfScore: 1, entityBoost: 0, contextBoost: 0, exactMatchBoost: 0, routingBoost: 0, versionBoost: 0, documentStageBoost: 0 },
      { documentId: 2, chunkIndex: 0, finalScore: 1.7, confidence: "plausible" as const, key: "e", chunkId: 5, rrfScore: 1, entityBoost: 0, contextBoost: 0, exactMatchBoost: 0, routingBoost: 0, versionBoost: 0, documentStageBoost: 0 },
    ];
    const diverse = applyResultDiversity(ranked, 4, 3);
    expect(diverse.filter((d) => d.documentId === 1).length).toBeLessThanOrEqual(3);
    expect(diverse.some((d) => d.documentId === 2)).toBe(true);
  });
});
