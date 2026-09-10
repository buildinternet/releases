import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../../../../tests/db-helper.js";
import { aiModelRoutes } from "./ai-models.js";
import { putStoredAiLaneModels } from "../queries/site-settings.js";
import { clearAiLaneModelCache } from "../lib/ai-lane-models.js";

let h: TestDatabase;
const originalFetch = globalThis.fetch;

function secretBinding(value: string) {
  return { get: async () => value };
}

function app(extra: Record<string, unknown> = {}) {
  const a = new Hono();
  a.route("/", aiModelRoutes);
  const env = {
    DB: h.db,
    RELEASES_API_KEY: secretBinding("root-secret"),
    SUMMARIZE_MODEL: "deepseek/deepseek-v4.1-flash",
    EXTRACT_MODEL: "deepseek/deepseek-v4.1-flash",
    FEED_ENRICH_MODEL: "deepseek/deepseek-v4.1-flash",
    MARKETING_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_API_KEY: secretBinding("or-key"),
    ...extra,
  };
  return { a, env };
}

const BASE = "https://api.releases.sh";
const auth = { Authorization: "Bearer root-secret" };

function stubCatalog(models: Array<{ id: string; name: string }>) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: models.map((m) => ({
          id: m.id,
          name: m.name,
          context_length: 128000,
          architecture: { input_modalities: ["text"] },
          pricing: { prompt: "0.00000015", completion: "0.0000006" },
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

beforeEach(() => {
  h = createTestDb();
  clearAiLaneModelCache();
  stubCatalog([{ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAiLaneModelCache();
  h.cleanup?.();
});

describe("GET /ai/models", () => {
  it("403s without admin auth", async () => {
    const { a, env } = app();
    const res = await a.request(`${BASE}/ai/models`, {}, env);
    expect(res.status).toBe(403);
  });

  it("returns wrangler defaults with no overlay", async () => {
    const { a, env } = app();
    const res = await a.request(`${BASE}/ai/models`, { headers: auth }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lanes: Array<{
        id: string;
        wranglerDefault: string;
        override: string | null;
        effective: string;
      }>;
      catalog: Array<{ id: string; vision: boolean }>;
    };
    const summarize = body.lanes.find((l) => l.id === "summarize");
    expect(summarize?.wranglerDefault).toBe("deepseek/deepseek-v4.1-flash");
    expect(summarize?.override).toBeNull();
    expect(summarize?.effective).toBe("deepseek/deepseek-v4.1-flash");
    expect(body.catalog.some((m) => m.id === "deepseek/deepseek-v4.1-flash")).toBe(true);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("surfaces a stored override as effective", async () => {
    await putStoredAiLaneModels(h.db, { summarize: "openai/gpt-4o-mini" });
    const { a, env } = app();
    const res = await a.request(`${BASE}/ai/models`, { headers: auth }, env);
    const body = (await res.json()) as {
      lanes: Array<{ id: string; override: string | null; effective: string }>;
    };
    const summarize = body.lanes.find((l) => l.id === "summarize");
    expect(summarize?.override).toBe("openai/gpt-4o-mini");
    expect(summarize?.effective).toBe("openai/gpt-4o-mini");
  });
});

describe("PUT /ai/models", () => {
  it("sets and clears an override", async () => {
    const { a, env } = app();
    const set = await a.request(
      `${BASE}/ai/models`,
      {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ models: { extract: "anthropic/claude-sonnet-4.6" } }),
      },
      env,
    );
    expect(set.status).toBe(200);
    const setBody = (await set.json()) as {
      lanes: Array<{ id: string; override: string | null; effective: string }>;
    };
    expect(setBody.lanes.find((l) => l.id === "extract")?.override).toBe(
      "anthropic/claude-sonnet-4.6",
    );

    const clear = await a.request(
      `${BASE}/ai/models`,
      {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ models: { extract: null } }),
      },
      env,
    );
    const clearBody = (await clear.json()) as {
      lanes: Array<{ id: string; override: string | null; effective: string }>;
    };
    const extract = clearBody.lanes.find((l) => l.id === "extract");
    expect(extract?.override).toBeNull();
    expect(extract?.effective).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("400s on a malformed model id", async () => {
    const { a, env } = app();
    const res = await a.request(
      `${BASE}/ai/models`,
      {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ models: { summarize: "not a model" } }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});
