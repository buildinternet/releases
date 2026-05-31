/**
 * Regression counterpart to poll-fetch-resolve-env.test.ts for the onboarding
 * workflow's own `resolveFetchEnv`. The onboarding backfill runs `fetchOne` over a
 * brand-new source where every feed item is fresh, so ingest-time enrichment
 * applies there too. An earlier version dropped the Anthropic key + FEED_ENRICH_*
 * / render-escalation bindings (every dropped field optional on `FetchOneEnv`, so
 * it type-checked), silently storing summary-only items un-enriched at onboard.
 */
import { describe, it, expect } from "bun:test";
import { resolveFetchEnv } from "../src/workflows/onboard-source.js";
import type { OnboardSourceWorkflowEnv } from "../src/workflows/onboard-source.js";

const secret = (value: string) => ({ get: async () => value });

function buildEnv(): OnboardSourceWorkflowEnv {
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
  } as unknown as OnboardSourceWorkflowEnv;
}

describe("resolveFetchEnv (onboard-source workflow)", () => {
  it("forwards the Anthropic key + gateway opts so the onboarding backfill can enrich", async () => {
    const env = buildEnv();
    const fetchEnv = await resolveFetchEnv(env);
    expect(fetchEnv.ANTHROPIC_API_KEY).toBe(env.ANTHROPIC_API_KEY);
    expect(fetchEnv.ANTHROPIC_BASE_URL).toBe("https://gw.example/anthropic");
    expect(fetchEnv.AI_GATEWAY_TOKEN).toBe(env.AI_GATEWAY_TOKEN);
  });

  it("forwards the FEED_ENRICH_* tuning vars + render-escalation creds", async () => {
    const env = buildEnv();
    const fetchEnv = await resolveFetchEnv(env);
    expect(fetchEnv.FEED_ENRICH_ENABLED).toBe("true");
    expect(fetchEnv.FEED_THIN_CHARS).toBe("600");
    expect(fetchEnv.FEED_ENRICH_MAX_PER_FIRE).toBe("10");
    expect(fetchEnv.CLOUDFLARE_ACCOUNT_ID).toBe(env.CLOUDFLARE_ACCOUNT_ID);
    expect(fetchEnv.CLOUDFLARE_API_TOKEN).toBe(env.CLOUDFLARE_API_TOKEN);
  });
});
