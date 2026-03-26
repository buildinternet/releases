export class AdapterError extends Error {
  constructor(
    public adapter: string,
    message: string,
    public cause?: Error,
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
  constructor(jobId: string, timeoutMs: number) {
    super(`Crawl job ${jobId} timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "CrawlTimeoutError";
  }
}

export class CrawlJobError extends Error {
  constructor(jobId: string, public jobStatus: string) {
    super(`Crawl job ${jobId} ended with status: ${jobStatus}`);
    this.name = "CrawlJobError";
  }
}
