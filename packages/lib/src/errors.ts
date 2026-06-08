export type ErrorCategory = "infra" | "extraction" | "validation" | "model" | "bot_challenge";

export class CategorizedError extends Error {
  constructor(
    public readonly category: ErrorCategory,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CategorizedError";
  }
}

export class AdapterError extends Error {
  constructor(
    public adapter: string,
    message: string,
    public cause?: Error,
    public category: ErrorCategory = "extraction",
  ) {
    super(`[${adapter}] ${message}`);
    this.name = "AdapterError";
  }
}

export class AIError extends Error {
  constructor(
    message: string,
    public cause?: Error,
  ) {
    super(message);
    this.name = "AIError";
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class CrawlTimeoutError extends Error {
  readonly category: ErrorCategory = "infra";
  constructor(jobId: string, timeoutMs: number) {
    super(`Crawl job ${jobId} timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "CrawlTimeoutError";
  }
}

export class CrawlJobError extends Error {
  readonly category: ErrorCategory = "infra";
  constructor(
    jobId: string,
    public jobStatus: string,
  ) {
    super(`Crawl job ${jobId} ended with status: ${jobStatus}`);
    this.name = "CrawlJobError";
  }
}

/**
 * Thrown when a feed URL returns a 4xx response. Distinct from generic
 * `Error` so callers can react: most 4xx is evidence the URL is gone (renamed,
 * removed) and warrants invalidating the stored feedUrl after a streak;
 * 5xx is transient and should not. The exceptions are 429 (Too Many Requests)
 * and 408 (Request Timeout): those are transient rate-limit/timeout signals,
 * NOT a gone URL — see {@link isTransientFeedHttpStatus}. `retryAfterMs` carries
 * the server's `Retry-After` hint (parsed to milliseconds) when present.
 */
export class FeedHttpError extends Error {
  constructor(
    public status: number,
    public feedUrl: string,
    statusText: string,
    public retryAfterMs?: number,
  ) {
    super(`Feed fetch failed: ${status} ${statusText} (${feedUrl})`);
    this.name = "FeedHttpError";
  }
}

/**
 * Whether a feed 4xx status is a transient rate-limit/timeout (429/408) rather
 * than evidence the feed URL is gone (404/410/403…). Transient statuses get
 * exponential backoff (honoring `Retry-After`) instead of counting toward
 * feedUrl invalidation, and are treated as expected — no failure-alert email.
 */
export function isTransientFeedHttpStatus(status: number): boolean {
  return status === 429 || status === 408;
}

/**
 * Thrown by the Firecrawl client on a non-2xx response (or a 2xx with a
 * non-JSON body). Carries the HTTP `status` so callers can branch — e.g. the
 * monitor reconcile helper treats a 404 on `updateMonitor` as "monitor deleted
 * upstream" and recreates it, but lets transient 5xx errors propagate.
 */
export class FirecrawlError extends Error {
  constructor(
    public status: number,
    public method: string,
    public path: string,
    public body: string,
    message?: string,
  ) {
    super(message ?? `Firecrawl ${method} ${path} failed: ${status} ${body.slice(0, 300)}`);
    this.name = "FirecrawlError";
  }
}
