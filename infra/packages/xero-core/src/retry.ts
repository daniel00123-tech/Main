export type XeroRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

const DEFAULT_OPTIONS: Required<XeroRetryOptions> = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8000,
};

function pauseMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isXeroApiError(error: unknown): error is { provider: { status: number; retryAfterSeconds?: number } } {
  return (
    typeof error === "object" &&
    error != null &&
    "provider" in error &&
    typeof (error as { provider?: { status?: unknown } }).provider?.status === "number"
  );
}

function isIdempotentSafeRetry(error: unknown): boolean {
  if (!isXeroApiError(error)) return false;
  return isRetryableStatus(error.provider.status);
}

/**
 * Bounded retry for transient Xero failures (429 / 5xx).
 * Callers must only use this for idempotent reads or when execution store prevents duplicate writes.
 */
export async function withXeroRetry<T>(
  fn: () => Promise<T>,
  options?: XeroRetryOptions,
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isIdempotentSafeRetry(error) || attempt >= opts.maxAttempts) throw error;
      const retryAfterHeader =
        isXeroApiError(error) && error.provider.retryAfterSeconds
          ? error.provider.retryAfterSeconds * 1000
          : undefined;
      const exponential = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 200);
      const delay = retryAfterHeader ?? exponential + jitter;
      await pauseMs(delay);
    }
  }
  throw lastError;
}

export { isRetryableStatus, isIdempotentSafeRetry };
