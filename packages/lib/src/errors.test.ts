import { describe, it, expect } from "bun:test";
import {
  CategorizedError,
  AdapterError,
  CrawlTimeoutError,
  CrawlJobError,
  type ErrorCategory,
} from "./errors";

describe("CategorizedError", () => {
  it("carries the category field", () => {
    const err = new CategorizedError("infra", "disk full");
    expect(err.category).toBe("infra");
    expect(err.message).toBe("disk full");
    expect(err.name).toBe("CategorizedError");
    expect(err instanceof Error).toBe(true);
  });

  it("accepts all four categories", () => {
    const categories: ErrorCategory[] = ["infra", "extraction", "validation", "model"];
    for (const cat of categories) {
      const e = new CategorizedError(cat, "msg");
      expect(e.category).toBe(cat);
    }
  });

  it("accepts an optional cause", () => {
    const cause = new Error("root cause");
    const err = new CategorizedError("model", "max tokens", cause);
    expect(err.cause).toBe(cause);
  });
});

describe("AdapterError", () => {
  it("defaults category to extraction", () => {
    const err = new AdapterError("crawl", "parse failed");
    expect(err.category).toBe("extraction");
  });

  it("accepts an explicit category override", () => {
    const err = new AdapterError("crawl", "5xx response", undefined, "infra");
    expect(err.category).toBe("infra");
  });

  it("includes adapter name in the message", () => {
    const err = new AdapterError("github", "not found", undefined, "validation");
    expect(err.message).toBe("[github] not found");
  });
});

describe("CrawlTimeoutError", () => {
  it("has category infra", () => {
    const err = new CrawlTimeoutError("job_1", 300_000);
    expect(err.category).toBe("infra");
  });
});

describe("CrawlJobError", () => {
  it("has category infra", () => {
    const err = new CrawlJobError("job_1", "cancelled_due_to_timeout");
    expect(err.category).toBe("infra");
  });
});
