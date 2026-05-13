export type ErrorCategory = "infra" | "extraction" | "validation" | "model";

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
 * `Error` so callers can react: 4xx is evidence the URL is gone (renamed,
 * removed) and warrants invalidating the stored feedUrl after a streak;
 * 5xx is transient and should not.
 */
export class FeedHttpError extends Error {
  constructor(
    public status: number,
    public feedUrl: string,
    statusText: string,
  ) {
    super(`Feed fetch failed: ${status} ${statusText} (${feedUrl})`);
    this.name = "FeedHttpError";
  }
}
