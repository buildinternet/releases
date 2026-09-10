import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../../tests/db-helper.js";
import { putStoredAiLaneModels } from "../queries/site-settings.js";
import {
  clearAiLaneModelCache,
  effectiveLaneModel,
  fetchOpenRouterCatalog,
} from "./ai-lane-models.js";

let h: TestDatabase;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  h = createTestDb();
  clearAiLaneModelCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAiLaneModelCache();
  h.cleanup?.();
});

describe("effectiveLaneModel", () => {
  it("returns the wrangler var when no overlay is stored", async () => {
    const id = await effectiveLaneModel(
      { DB: h.db, SUMMARIZE_MODEL: "deepseek/deepseek-v4.1-flash" },
      "summarize",
    );
    expect(id).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("prefers a stored override", async () => {
    await putStoredAiLaneModels(h.db, { summarize: "openai/gpt-4o-mini" });
    const id = await effectiveLaneModel(
      { DB: h.db, SUMMARIZE_MODEL: "deepseek/deepseek-v4.1-flash" },
      "summarize",
    );
    expect(id).toBe("openai/gpt-4o-mini");
  });

  it("fails open to the wrangler var when DB is missing", async () => {
    const id = await effectiveLaneModel(
      { SUMMARIZE_MODEL: "deepseek/deepseek-v4.1-flash" },
      "summarize",
    );
    expect(id).toBe("deepseek/deepseek-v4.1-flash");
  });
});

describe("fetchOpenRouterCatalog", () => {
  it("maps catalog rows and flags vision", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "deepseek/deepseek-v4.1-flash",
              name: "DeepSeek V4.1 Flash",
              context_length: 1_000_000,
              architecture: { input_modalities: ["text", "image"] },
              pricing: { prompt: "0.00000014", completion: "0.00000028" },
            },
            { id: "not-an-id", name: "skip me" },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const { catalog, catalogError } = await fetchOpenRouterCatalog({
      OPENROUTER_API_KEY: { get: async () => "or-key" },
    });
    expect(catalogError).toBeNull();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.id).toBe("deepseek/deepseek-v4.1-flash");
    expect(catalog[0]?.vision).toBe(true);
    expect(catalog[0]?.promptPricePerMillion).toBeCloseTo(0.14);
  });
});
