import { describe, it, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import {
  enableLocalAdminEnv,
  disableLocalAdminEnv,
  stubFetch,
  restoreFetch,
} from "./test-helpers.test";

let setAiLaneModelAction: (typeof import("./ai-models"))["setAiLaneModelAction"];

describe("setAiLaneModelAction", () => {
  beforeAll(async () => {
    ({ setAiLaneModelAction } = await import("./ai-models"));
  });

  beforeEach(() => {
    enableLocalAdminEnv();
  });

  afterEach(() => {
    restoreFetch();
    disableLocalAdminEnv();
  });

  it("PUTs a single-lane overlay to /v1/ai/models", async () => {
    const recorded = stubFetch([
      new Response(
        JSON.stringify({
          lanes: [],
          catalog: [],
          catalogFetchedAt: null,
          catalogError: null,
          updatedAt: "2026-09-10T00:00:00.000Z",
        }),
        { status: 200 },
      ),
    ]);

    const result = await setAiLaneModelAction("summarize", "openai/gpt-4o-mini");

    expect(result.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe("PUT");
    expect(recorded[0]?.url).toBe("http://api.test.local/v1/ai/models");
    expect(JSON.parse(recorded[0]?.body ?? "null")).toEqual({
      models: { summarize: "openai/gpt-4o-mini" },
    });
  });
});
