/**
 * Regression: the production poll-and-fetch Workflow (POLL_FETCH_USE_WORKFLOW=true)
 * builds the env it hands to `fetchOne` via `resolveFetchEnv`. An earlier version
 * dropped the Anthropic key and the FEED_ENRICH_* / Cloudflare render-escalation
 * bindings, which silently disabled ingest-time feed enrichment (and the marketing
 * classifier) on the workflow path: with `FEED_ENRICH_ENABLED` missing the flag
 * fell back to its hardcoded `false` default, and with no Anthropic key
 * `buildEnrichDeps` returned null — so `buildEnrichMap` always returned an empty
 * map. Every dropped field is OPTIONAL on `FetchOneEnv`, so the omission
 * type-checked and shipped silently. These assertions pin the forwarding so a
 * future drop fails loudly here instead of in production.
 */
import { describe, it, expect } from "bun:test";
import { resolveFetchEnv } from "../src/workflows/poll-and-fetch.js";
import type { PollAndFetchWorkflowEnv } from "../src/workflows/poll-and-fetch.js";

const secret = (value: string) => ({ get: async () => value });

function buildEnv(): PollAndFetchWorkflowEnv {
  return {
    DB: {} as never,
    ANTHROPIC_API_KEY: secret("sk-ant-test"),
    ANTHROPIC_BASE_URL: "https://gw.example/anthropic",
    AI_GATEWAY_TOKEN: secret("gw-token"),
    FEED_ENRICH_ENABLED: "true",
    FEED_ENRICH_MAX_PER_FIRE: "10",
    FEED_THIN_CHARS: "600",
    CLOUDFLARE_ACCOUNT_ID: secret("acct"),
    CLOUDFLARE_API_TOKEN: secret("cf-token"),
    ENVIRONMENT: "production",
    OPENROUTER_ENABLED: "true",
    OPENROUTER_API_KEY: secret("sk-or-test"),
    OPENROUTER_BASE_URL: "https://openrouter.example/api/v1",
    MARKETING_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
    FEED_ENRICH_MODEL: "deepseek/deepseek-v4-flash",
    SUMMARIZE_MODEL: "deepseek/deepseek-v4-flash",
    EXTRACT_MODEL: "deepseek/deepseek-v4-pro",
  } as unknown as PollAndFetchWorkflowEnv;
}

describe("resolveFetchEnv (poll-and-fetch workflow)", () => {
  it("forwards the Anthropic key + gateway opts so ingest-time enrichment can build a client", async () => {
    const env = buildEnv();
    const fetchEnv = await resolveFetchEnv(env);
    expect(fetchEnv.ANTHROPIC_API_KEY).toBe(env.ANTHROPIC_API_KEY);
    expect(fetchEnv.ANTHROPIC_BASE_URL).toBe("https://gw.example/anthropic");
    expect(fetchEnv.AI_GATEWAY_TOKEN).toBe(env.AI_GATEWAY_TOKEN);
  });

  it("forwards the FEED_ENRICH_* tuning vars so the flag + thinChars resolve from the wrangler var", async () => {
    const fetchEnv = await resolveFetchEnv(buildEnv());
    expect(fetchEnv.FEED_ENRICH_ENABLED).toBe("true");
    expect(fetchEnv.FEED_THIN_CHARS).toBe("600");
    expect(fetchEnv.FEED_ENRICH_MAX_PER_FIRE).toBe("10");
  });

  it("forwards the Cloudflare render-escalation creds enrichment uses for Browser Rendering", async () => {
    const env = buildEnv();
    const fetchEnv = await resolveFetchEnv(env);
    expect(fetchEnv.CLOUDFLARE_ACCOUNT_ID).toBe(env.CLOUDFLARE_ACCOUNT_ID);
    expect(fetchEnv.CLOUDFLARE_API_TOKEN).toBe(env.CLOUDFLARE_API_TOKEN);
  });

  // The 2026-07-23 outage: these were forwarded nowhere, so `resolveTextModel`
  // read `orModel === undefined` — its "this lane is off" signal — and silently
  // routed the marketing classifier + feed-enrich extractor to Anthropic Haiku.
  // The fall-through logs nothing (an empty model var is the intended off
  // switch), so it stayed invisible until the Anthropic spend cap tripped.
  it("forwards the OpenRouter lane config so the cheap lanes don't fall back to Anthropic", async () => {
    const env = buildEnv();
    const fetchEnv = await resolveFetchEnv(env);
    expect(fetchEnv.OPENROUTER_API_KEY).toBe(env.OPENROUTER_API_KEY);
    expect(fetchEnv.OPENROUTER_ENABLED).toBe("true");
    expect(fetchEnv.OPENROUTER_BASE_URL).toBe("https://openrouter.example/api/v1");
    expect(fetchEnv.ENVIRONMENT).toBe("production");
  });

  it("forwards every per-lane OpenRouter model var", async () => {
    const fetchEnv = await resolveFetchEnv(buildEnv());
    expect(fetchEnv.MARKETING_CLASSIFIER_MODEL).toBe("google/gemini-2.5-flash-lite");
    expect(fetchEnv.FEED_ENRICH_MODEL).toBe("deepseek/deepseek-v4-flash");
    expect(fetchEnv.SUMMARIZE_MODEL).toBe("deepseek/deepseek-v4-flash");
    expect(fetchEnv.EXTRACT_MODEL).toBe("deepseek/deepseek-v4-pro");
  });
});
