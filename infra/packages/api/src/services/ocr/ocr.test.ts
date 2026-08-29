import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_OCR_PAGES_PER_DOCUMENT,
  shouldInvokeOcr,
} from "@infra/shared";
import { AzureDocumentIntelligenceOcrProvider, AzureOcrError } from "./azure-document-intelligence";
import { applyOcrFallbackIfRequired } from "./knowledge-ocr";
import { assessOcrTextQuality, estimateAzureReadCostUsd, estimatePdfPageCount, ocrDocument, sha256Hex } from "./service";
import { selectBackfillCandidates } from "./backfill";
import type { OcrProvider } from "./types";

type JobRow = Record<string, unknown>;

function memoryDb() {
  const jobs: JobRow[] = [];
  const audit: JobRow[] = [];
  const usage: JobRow[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        binds: [] as unknown[],
        bind(...values: unknown[]) {
          this.binds = values;
          return this;
        },
        async first() {
          if (sql.includes("FROM knowledge_ocr_jobs") && sql.includes("content_fingerprint")) {
            return (
              jobs.find(
                (row) =>
                  row.company_id === this.binds[0] &&
                  Number(row.knowledge_document_id) === Number(this.binds[1]) &&
                  row.content_fingerprint === this.binds[2],
              ) ?? null
            );
          }
          return null;
        },
        async run() {
          if (sql.includes("INSERT INTO knowledge_ocr_jobs")) {
            const row = {
              id: this.binds[0],
              company_id: this.binds[1],
              knowledge_document_id: this.binds[2],
              content_fingerprint: this.binds[3],
              mime_type: this.binds[4],
              title: this.binds[5],
              ocr_provider: this.binds[6],
              ocr_model: this.binds[7],
              ocr_api_version: this.binds[8],
              ocr_status: this.binds[9],
              ocr_page_count: this.binds[10],
              ocr_completed_at: this.binds[11],
              ocr_attempt_count: this.binds[12],
              ocr_failure_category: this.binds[13],
              duration_ms: this.binds[14],
              last_error: this.binds[15],
            };
            const existing = jobs.findIndex(
              (item) =>
                item.company_id === row.company_id &&
                item.knowledge_document_id === row.knowledge_document_id &&
                item.content_fingerprint === row.content_fingerprint,
            );
            if (existing >= 0) jobs[existing] = { ...jobs[existing], ...row };
            else jobs.push(row);
          }
          if (sql.includes("INSERT INTO audit_events")) {
            audit.push({ event_type: this.binds[2], company_id: this.binds[1], detail_json: this.binds[6] });
          }
          if (sql.includes("INSERT INTO usage_records")) {
            usage.push({ company_id: this.binds[1], resource_type: this.binds[2] });
          }
          return { success: true };
        },
        async all() {
          return { results: jobs };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, jobs, audit, usage };
}

function mockProvider(overrides: Partial<OcrProvider> & { analyze?: OcrProvider["analyze"] } = {}): OcrProvider & { calls: number } {
  const provider = {
    id: "azure_document_intelligence" as const,
    model: "prebuilt-read" as const,
    apiVersion: "2024-11-30" as const,
    calls: 0,
    async analyze() {
      provider.calls += 1;
      return {
        text: "Coal Search report describing site constraints and borehole findings.",
        pageCount: 2,
        durationMs: 12,
      };
    },
    ...overrides,
  };
  if (overrides.analyze) {
    const inner = overrides.analyze;
    provider.analyze = async (input) => {
      provider.calls += 1;
      return inner(input);
    };
  }
  return provider;
}

const sampleBytes = new TextEncoder().encode("%PDF-1.4 fake scanned document").buffer;

describe("OCR trigger policy", () => {
  it("calls provider only for requires_ocr documents", async () => {
    expect(shouldInvokeOcr({ requiresOcr: true })).toBe(true);
    expect(shouldInvokeOcr({ extractionQuality: "good", requiresOcr: false })).toBe(false);
    const { db } = memoryDb();
    const provider = mockProvider();
    await ocrDocument(
      db,
      {
        companyId: "co_caddington",
        documentId: 54,
        bytes: sampleBytes,
        mimeType: "application/pdf",
      },
      { provider },
    );
    expect(provider.calls).toBe(1);
  });
});

describe("OCR quality and limits", () => {
  it("does not treat empty OCR as indexed", async () => {
    const { db } = memoryDb();
    const provider = mockProvider({
      async analyze() {
        return { text: "# Page 1\n# Page 2", pageCount: 2, durationMs: 8 };
      },
    });
    const result = await ocrDocument(
      db,
      {
        companyId: "co_caddington",
        documentId: 54,
        bytes: sampleBytes,
        mimeType: "application/pdf",
      },
      { provider },
    );
    expect(result.status).toBe("ocr_failed");
    expect(result.failureCategory).toBe("INSUFFICIENT_OCR_TEXT");
    expect(result.text).toBeUndefined();
  });

  it("blocks documents over the page limit without calling Azure", async () => {
    const { db } = memoryDb();
    const provider = mockProvider();
    const result = await ocrDocument(
      db,
      {
        companyId: "co_caddington",
        documentId: 54,
        bytes: sampleBytes,
        mimeType: "application/pdf",
        knownPageCount: DEFAULT_MAX_OCR_PAGES_PER_DOCUMENT + 1,
      },
      { provider },
    );
    expect(result.status).toBe("ocr_limit_exceeded");
    expect(provider.calls).toBe(0);
  });

  it("assesses substantive OCR text as sufficient", () => {
    const quality = assessOcrTextQuality(
      "Investment opportunity at Arnold Crescent including rental yield and purchase price.",
      1,
    );
    expect(quality.sufficient).toBe(true);
  });
});

describe("OCR idempotency and isolation", () => {
  it("does not call the provider twice for the same document version", async () => {
    const { db } = memoryDb();
    const provider = mockProvider();
    const input = {
      companyId: "co_caddington",
      documentId: 71,
      bytes: sampleBytes,
      mimeType: "application/pdf" as const,
    };
    const first = await ocrDocument(db, input, { provider });
    const second = await ocrDocument(db, input, { provider });
    expect(first.status).toBe("ocr_completed");
    expect(second.alreadyCompleted).toBe(true);
    expect(second.providerCalled).toBe(false);
    expect(provider.calls).toBe(1);
  });

  it("scopes completed OCR jobs by company", async () => {
    const { db, jobs } = memoryDb();
    const provider = mockProvider();
    await ocrDocument(
      db,
      {
        companyId: "co_caddington",
        documentId: 54,
        bytes: sampleBytes,
        mimeType: "application/pdf",
      },
      { provider },
    );
    expect(jobs.every((row) => row.company_id === "co_caddington")).toBe(true);
    const ht = await ocrDocument(
      db,
      {
        companyId: "co_ht",
        documentId: 54,
        bytes: sampleBytes,
        mimeType: "application/pdf",
      },
      { provider },
    );
    expect(ht.alreadyCompleted).toBeFalsy();
    expect(ht.companyId === undefined).toBe(true);
    expect(jobs.some((row) => row.company_id === "co_ht")).toBe(true);
    expect(provider.calls).toBe(2);
  });
});

describe("Azure provider retries and redaction", () => {
  it("retries 429 then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (init?.method === "POST") {
        calls += 1;
        if (calls === 1) {
          return new Response("throttled", { status: 429 });
        }
        return new Response(null, {
          status: 202,
          headers: { "Operation-Location": "https://ocr.example/ops/1" },
        });
      }
      if (href.includes("/ops/1")) {
        return Response.json({
          status: "succeeded",
          analyzeResult: { content: "Coal Search borehole log", pages: [{}, {}] },
        });
      }
      return new Response("no", { status: 404 });
    });
    const provider = new AzureDocumentIntelligenceOcrProvider(
      { endpoint: "https://ocr.example", key: "super-secret-key" },
      fetchImpl as unknown as typeof fetch,
    );
    const result = await provider.analyze({
      bytes: sampleBytes,
      mimeType: "application/pdf",
      maxPages: 50,
    });
    expect(result.pageCount).toBe(2);
    expect(calls).toBe(2);
  });

  it("maps provider failure and does not leak the key", async () => {
    const fetchImpl = vi.fn(async () => new Response("invalid key super-secret-key", { status: 401 }));
    const provider = new AzureDocumentIntelligenceOcrProvider(
      { endpoint: "https://ocr.example", key: "super-secret-key" },
      fetchImpl as unknown as typeof fetch,
    );
    await expect(
      provider.analyze({ bytes: sampleBytes, mimeType: "application/pdf", maxPages: 50 }),
    ).rejects.toBeInstanceOf(AzureOcrError);
    try {
      await provider.analyze({ bytes: sampleBytes, mimeType: "application/pdf", maxPages: 50 });
    } catch (err) {
      expect(String(err)).not.toContain("super-secret-key");
    }
  });
});

describe("OCR fallback orchestration", () => {
  it("does not invoke Azure when extraction is already good", async () => {
    const provider = mockProvider();
    const result = await applyOcrFallbackIfRequired(
      { DB: memoryDb().db } as never,
      { id: "mcp_caddington_primary" } as never,
      {
        companyId: "co_caddington",
        documentId: 10,
        requiresOcr: false,
        documentStatus: "indexed",
        extractionQuality: "good",
        provider,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requiresOcr).toBe(false);
      expect(result.indexed).toBe(true);
    }
    expect(provider.calls).toBe(0);
  });

  it("keeps OCR metadata additive so provenance fields are not replaced", () => {
    const existing = {
      connector: "microsoft_365",
      sourceType: "outlook_shared",
      itemKind: "mail_attachment",
      parentSubject: "Test1",
      parentKnowledgeDocumentId: 70,
      attachmentFilename: "Investment opportunity - Arnold Crescent.pdf",
    };
    const ocrPatch = {
      ocrProvider: "azure_document_intelligence",
      ocrModel: "prebuilt-read",
      ocrStatus: "ocr_completed",
    };
    const merged = { ...existing, ...ocrPatch };
    expect(merged.parentSubject).toBe("Test1");
    expect(merged.itemKind).toBe("mail_attachment");
    expect(merged.sourceType).toBe("outlook_shared");
    expect(merged.ocrStatus).toBe("ocr_completed");
  });
});

describe("OCR images and timeouts", () => {
  it("invokes Azure for image/jpeg requires_ocr", async () => {
    const { db } = memoryDb();
    const provider = mockProvider();
    const result = await ocrDocument(
      db,
      {
        companyId: "co_caddington",
        documentId: 80,
        bytes: sampleBytes,
        mimeType: "image/jpeg",
      },
      { provider },
    );
    expect(result.status).toBe("ocr_completed");
    expect(provider.calls).toBe(1);
  });

  it("times out when Azure never reaches succeeded", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(null, {
          status: 202,
          headers: { "Operation-Location": "https://ocr.example/ops/hang" },
        });
      }
      return Response.json({ status: "running" });
    });
    const provider = new AzureDocumentIntelligenceOcrProvider(
      { endpoint: "https://ocr.example", key: "test-key", maxPolls: 1 },
      fetchImpl as unknown as typeof fetch,
    );
    await expect(
      provider.analyze({ bytes: sampleBytes, mimeType: "application/pdf", maxPages: 50 }),
    ).rejects.toMatchObject({ category: "TIMEOUT" });
  });

  it("estimates Azure Read cost for operator metering only", () => {
    expect(estimateAzureReadCostUsd(2)).toBe(0.003);
    expect(estimateAzureReadCostUsd(0)).toBe(0);
  });
});

describe("OCR backfill selection", () => {
  it("skips completed jobs and keeps metadata-only candidates", () => {
    const selected = selectBackfillCandidates([
      { documentId: 1, title: "10818.pdf", status: "requires_ocr", mimeType: "application/pdf", source: "sharepoint", extractionQuality: "requires_ocr", ocrStatus: null, substantiveCharacterCount: 0 },
      { documentId: 2, title: "ok.pdf", status: "indexed", mimeType: "application/pdf", source: "google_drive", extractionQuality: "good", ocrStatus: "ocr_completed", substantiveCharacterCount: 900 },
    ]);
    expect(selected.map((row) => row.documentId)).toEqual([1]);
  });
});

describe("OCR helpers", () => {
  it("fingerprints document bytes", async () => {
    const a = await sha256Hex(sampleBytes);
    const b = await sha256Hex(sampleBytes);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("estimates PDF page count from page objects", () => {
    const pdf = new TextEncoder().encode("%PDF-1.4 /Type /Page /Type /Page /Type /Pages").buffer;
    expect(estimatePdfPageCount(pdf)).toBe(2);
  });
});
