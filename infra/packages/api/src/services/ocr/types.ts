import type { OcrFailureCategory, OcrStatus } from "@infra/shared";

export type OcrAnalyzeResult = {
  text: string;
  pageCount: number;
  durationMs: number;
};

export type OcrProviderError = {
  retryable: boolean;
  category: OcrFailureCategory;
  message: string;
  status?: number;
};

export interface OcrProvider {
  readonly id: "azure_document_intelligence";
  readonly model: "prebuilt-read";
  readonly apiVersion: "2024-11-30";
  analyze(input: {
    bytes: ArrayBuffer;
    mimeType: string;
    maxPages: number;
  }): Promise<OcrAnalyzeResult>;
}

export type OcrDocumentInput = {
  companyId: string;
  documentId: number;
  bytes: ArrayBuffer;
  mimeType: string | null;
  title?: string | null;
  contentFingerprint?: string;
  knownPageCount?: number | null;
};

export type OcrDocumentResult = {
  status: OcrStatus;
  providerCalled: boolean;
  text?: string;
  pageCount?: number | null;
  attemptCount: number;
  failureCategory?: OcrFailureCategory | null;
  contentFingerprint: string;
  durationMs?: number | null;
  alreadyCompleted?: boolean;
  message?: string;
};
