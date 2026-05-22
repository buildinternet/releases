import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const KEYS = [
  "RELEASES_API_URL",
  "RELEASED_API_URL",
  "RELEASES_API_KEY",
  "RELEASED_API_KEY",
  "RELEASES_INGEST_MODEL",
  "RELEASED_INGEST_MODEL",
];

describe("config accessors honor both prefixes", () => {
  beforeEach(() => KEYS.forEach((k) => delete process.env[k]));
  afterEach(() => KEYS.forEach((k) => delete process.env[k]));

  test("apiUrl prefers RELEASES_ then falls back to RELEASED_", async () => {
    const { config } = await import("@releases/lib/config");
    process.env.RELEASED_API_URL = "https://old";
    expect(config.apiUrl()).toBe("https://old");
    process.env.RELEASES_API_URL = "https://new";
    expect(config.apiUrl()).toBe("https://new");
  });

  test("apiKey falls back to RELEASED_API_KEY", async () => {
    const { config } = await import("@releases/lib/config");
    process.env.RELEASED_API_KEY = "legacy";
    expect(config.apiKey()).toBe("legacy");
  });

  test("ingestModel falls back, keeps default", async () => {
    const { config } = await import("@releases/lib/config");
    expect(config.ingestModel()).toBe("claude-haiku-4-5-20251001");
    process.env.RELEASED_INGEST_MODEL = "x";
    expect(config.ingestModel()).toBe("x");
  });
});
