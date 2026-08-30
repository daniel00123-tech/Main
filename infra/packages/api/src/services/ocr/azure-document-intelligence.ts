import {
  DEFAULT_MAX_OCR_PROVIDER_ATTEMPTS,
  OCR_API_VERSION,
  OCR_MODEL_ID,
  OCR_PROVIDER_ID,
} from "@infra/shared";
import { sanitizeForLog } from "../secrets";
import type { Env } from "../../env";
import type { OcrAnalyzeResult, OcrProvider, OcrProviderError } from "./types";

export class AzureOcrError extends Error {
  readonly retryable: boolean;
  readonly category: OcrProviderError["category"];
  readonly status?: number;

  constructor(input: OcrProviderError) {
    super(input.message);
    this.name = "AzureOcrError";
    this.retryable = input.retryable;
    this.category = input.category;
    this.status = input.status;
  }
}

export function readAzureOcrConfig(env: Env): {
  endpoint: string;
  key: string;
  maxPages: number;
  maxBytes: number;
} | null {
  const endpoint = String(env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ?? "").trim().replace(/\/+$/, "");
  const key = String(env.AZURE_DOCUMENT_INTELLIGENCE_KEY ?? "").trim();
  if (!endpoint || !key) return null;
  const maxPages = Number(env.AZURE_OCR_MAX_PAGES ?? 50);
  const maxBytes = Number(env.AZURE_OCR_MAX_BYTES ?? 20 * 1024 * 1024);
  return {
    endpoint,
    key,
    maxPages: Number.isFinite(maxPages) && maxPages > 0 ? maxPages : 50,
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 20 * 1024 * 1024,
  };
}

export function isAzureOcrConfigured(env: Env): boolean {
  return readAzureOcrConfig(env) != null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyHttpError(status: number, bodyText: string): OcrProviderError {
  const safe = String(sanitizeForLog(bodyText)).slice(0, 180);
  if (status === 401 || status === 403) {
    return { retryable: false, category: "AUTHENTICATION", message: `Azure OCR auth failed (${status})`, status };
  }
  if (status === 429) {
    return { retryable: true, category: "RATE_LIMIT", message: `Azure OCR rate-limited (${status})`, status };
  }
  if (status === 408 || status === 504) {
    return { retryable: true, category: "TIMEOUT", message: `Azure OCR timeout (${status})`, status };
  }
  if (status >= 500) {
    return { retryable: true, category: "PROVIDER", message: `Azure OCR provider error (${status})`, status };
  }
  if (status === 400) {
    return { retryable: false, category: "DATA", message: `Azure OCR rejected document (${status}): ${safe}`, status };
  }
  return { retryable: false, category: "PROVIDER", message: `Azure OCR HTTP ${status}: ${safe}`, status };
}

function extractAnalyzeText(payload: Record<string, unknown>): { text: string; pageCount: number } {
  const analyzeResult =
    payload.analyzeResult && typeof payload.analyzeResult === "object"
      ? (payload.analyzeResult as Record<string, unknown>)
      : payload;
  const content = typeof analyzeResult.content === "string" ? analyzeResult.content : "";
  const pages = Array.isArray(analyzeResult.pages) ? analyzeResult.pages : [];
  let text = content.trim();
  if (!text && pages.length > 0) {
    const lines: string[] = [];
    for (const page of pages) {
      if (!page || typeof page !== "object") continue;
      const pageLines = (page as { lines?: Array<{ content?: string }> }).lines ?? [];
      for (const line of pageLines) {
        if (line?.content) lines.push(line.content);
      }
    }
    text = lines.join("\n").trim();
  }
  return { text, pageCount: pages.length };
}

export function contentTypeForOcr(mimeType: string | null | undefined): string {
  const normalized = (mimeType ?? "application/pdf").toLowerCase().split(";")[0]?.trim() ?? "application/pdf";
  if (normalized === "image/jpg") return "image/jpeg";
  if (normalized === "image/tif") return "image/tiff";
  return normalized;
}

function workerSafeFetch(fetchImpl?: typeof fetch): typeof fetch {
  const impl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  return ((input: RequestInfo | URL, init?: RequestInit) => impl(input, init)) as typeof fetch;
}

export class AzureDocumentIntelligenceOcrProvider implements OcrProvider {
  readonly id = OCR_PROVIDER_ID;
  readonly model = OCR_MODEL_ID;
  readonly apiVersion = OCR_API_VERSION;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: { endpoint: string; key: string; maxPolls?: number },
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = workerSafeFetch(fetchImpl);
  }

  async analyze(input: {
    bytes: ArrayBuffer;
    mimeType: string;
    maxPages: number;
  }): Promise<OcrAnalyzeResult> {
    const started = Date.now();
    const pages = Math.max(1, Math.min(input.maxPages, 50));
    const analyzeUrl = `${this.config.endpoint}/documentintelligence/documentModels/${this.model}:analyze?api-version=${this.apiVersion}&pages=1-${pages}`;
    let lastError: AzureOcrError | null = null;

    for (let attempt = 1; attempt <= DEFAULT_MAX_OCR_PROVIDER_ATTEMPTS; attempt++) {
      try {
        const submit = await this.fetchImpl(analyzeUrl, {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": this.config.key,
            "Content-Type": contentTypeForOcr(input.mimeType),
          },
          body: input.bytes,
        });

        if (submit.status !== 202) {
          const bodyText = await submit.text().catch(() => "");
          throw new AzureOcrError(classifyHttpError(submit.status, bodyText));
        }

        const operationLocation = submit.headers.get("Operation-Location");
        if (!operationLocation) {
          throw new AzureOcrError({
            retryable: false,
            category: "PROVIDER",
            message: "Azure OCR did not return Operation-Location",
          });
        }

        const result = await this.pollOperation(operationLocation);
        return { ...result, durationMs: Date.now() - started };
      } catch (err) {
        if (err instanceof AzureOcrError) {
          lastError = err;
          if (err.retryable && attempt < DEFAULT_MAX_OCR_PROVIDER_ATTEMPTS) {
            await sleep(400 * 2 ** (attempt - 1));
            continue;
          }
          throw err;
        }
        const message = err instanceof Error ? err.message : "Azure OCR request failed";
        const illegalInvocation = /illegal invocation/i.test(message);
        lastError = new AzureOcrError({
          retryable: !illegalInvocation,
          category: illegalInvocation ? "INTERNAL" : "TIMEOUT",
          message: illegalInvocation ? "Azure OCR fetch binding failed" : message,
        });
        if (attempt < DEFAULT_MAX_OCR_PROVIDER_ATTEMPTS) {
          await sleep(400 * 2 ** (attempt - 1));
          continue;
        }
        throw lastError;
      }
    }

    throw lastError ?? new AzureOcrError({ retryable: false, category: "UNKNOWN", message: "Azure OCR failed" });
  }

  private async pollOperation(operationLocation: string): Promise<{ text: string; pageCount: number }> {
    const maxPolls = this.config.maxPolls ?? 20;
    for (let poll = 0; poll < maxPolls; poll++) {
      if (poll > 0) await sleep(Math.min(1500 * poll, 4000));
      const response = await this.fetchImpl(operationLocation, {
        headers: { "Ocp-Apim-Subscription-Key": this.config.key },
      });
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new AzureOcrError(classifyHttpError(response.status, bodyText));
      }
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const status = String(payload.status ?? "").toLowerCase();
      if (status === "succeeded") {
        return extractAnalyzeText(payload);
      }
      if (status === "failed") {
        const error = payload.error && typeof payload.error === "object" ? payload.error : {};
        const message = String((error as { message?: string }).message ?? "Azure OCR processing failed");
        throw new AzureOcrError({
          retryable: false,
          category: "PROVIDER",
          message: String(sanitizeForLog(message)).slice(0, 180),
        });
      }
    }
    throw new AzureOcrError({
      retryable: true,
      category: "TIMEOUT",
      message: "Azure OCR polling timed out",
    });
  }
}

export function createAzureOcrProvider(env: Env): AzureDocumentIntelligenceOcrProvider | null {
  const config = readAzureOcrConfig(env);
  if (!config) return null;
  return new AzureDocumentIntelligenceOcrProvider({ endpoint: config.endpoint, key: config.key });
}
