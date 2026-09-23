import { describe, it, expect } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { createTestDb, createTestApp } from "./setup";
import { firecrawlRoutes } from "../src/routes/firecrawl";

function secretBinding(value: string) {
  return { get: async () => value };
}

const WEBHOOK_PATH = "/v1/integrations/firecrawl/webhook";
const TOKEN = "fc-test-token";

describe("POST /v1/integrations/firecrawl/webhook — JSON body boundary", () => {
  it("malformed JSON returns 400 instead of silently skipping as no_source_id", async () => {
    const fetchApi = createTestApp(createTestDb(), firecrawlRoutes, {
      env: { FIRECRAWL_WEBHOOK_SECRET: secretBinding(TOKEN) },
      onError: (err, c) => {
        if (err instanceof HTTPException) {
          const status = err.status;
          return c.json(
            { error: status === 400 ? "bad_request" : "http_error", message: err.message },
            status,
          );
        }
        return c.json({ error: "internal_error", message: String(err) }, 500);
      },
    });

    const res = await fetchApi(
      new Request(`https://api${WEBHOOK_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Firecrawl-Token": TOKEN,
        },
        body: "{not json",
      }),
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("bad_request");
    expect(json.message).toBe("invalid JSON body");
  });
});
