/**
 * Regression for #2171: `POST /v1/sources/:slug/fetch` (workers/api/src/routes/
 * sources.ts) used to hand-build the `FetchOneEnv` it passes to `fetchOne` as an
 * inline object literal instead of calling `buildFetchOneEnv` (the single source
 * of truth in `_fetch-env.ts`, shared by the poll-and-fetch and onboard-source
 * workflows). That literal forwarded ZERO AI-lane keys — no `ANTHROPIC_API_KEY`,
 * no `OPENROUTER_*`, no `FEED_ENRICH_*`, no `SUMMARIZE_MODEL` — so a manual fetch
 * silently skipped feed enrichment: `FEED_ENRICH_ENABLED` missing fell back to the
 * flag's hardcoded `false` default, and even past that gate `resolveArticleExtractModel`
 * saw no Anthropic key and returned null. Every dropped field is OPTIONAL on
 * `FetchOneEnv`, so the omission type-checked and shipped silently (the third
 * instance of this bug class — see the `_fetch-env.ts` module header).
 *
 * These tests pin two things:
 * 1. `buildFetchOneEnv` — now the ONLY construction site sources.ts's fetch route
 *    uses — actually forwards the AI-lane keys from an `Env`-shaped object (the
 *    real worker binding type `c.env` has at that call site).
 * 2. `resolveArticleExtractModel` (feed-enrich's model resolver) resolves a
 *    non-null model from the builder's output when an Anthropic key is present,
 *    proving the forwarded env is functionally sufficient to enrich — not just
 *    present as dead data. Feeding it the OLD bug's literal shape (AI-lane keys
 *    entirely absent) reproduces the exact silent-null failure this issue
 *    describes, so the contrast is the regression guard.
 */
import { describe, it, expect } from "bun:test";
import { buildFetchOneEnv, type WorkflowFetchEnv } from "../src/workflows/_fetch-env.js";
import { resolveArticleExtractModel } from "../src/lib/text-model.js";
import type { Env } from "../src/index.js";

const secret = (value: string) => ({ get: async () => value });

/** Minimal but realistic `Env["Bindings"]` slice — the exact shape `c.env` has
 *  at the `POST /sources/:slug/fetch` call site in routes/sources.ts. */
function buildRouteEnv(): Env["Bindings"] {
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
    OPENROUTER_ENABLED: "false",
    SUMMARIZE_MODEL: "deepseek/deepseek-v4-flash",
    EXTRACT_MODEL: "deepseek/deepseek-v4-pro",
    MARKETING_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
    FEED_ENRICH_MODEL: "deepseek/deepseek-v4-flash",
  } as unknown as Env["Bindings"];
}

describe("buildFetchOneEnv from the manual-fetch route's Env (#2171)", () => {
  it("forwards the Anthropic key + gateway opts", async () => {
    const env = buildRouteEnv();
    const fetchEnv = await buildFetchOneEnv(env);
    expect(fetchEnv.ANTHROPIC_API_KEY).toBe(env.ANTHROPIC_API_KEY);
    expect(fetchEnv.ANTHROPIC_BASE_URL).toBe("https://gw.example/anthropic");
    expect(fetchEnv.AI_GATEWAY_TOKEN).toBe(env.AI_GATEWAY_TOKEN);
  });

  it("forwards the FEED_ENRICH_* tuning vars + render-escalation creds", async () => {
    const env = buildRouteEnv();
    const fetchEnv = await buildFetchOneEnv(env);
    expect(fetchEnv.FEED_ENRICH_ENABLED).toBe("true");
    expect(fetchEnv.FEED_THIN_CHARS).toBe("600");
    expect(fetchEnv.FEED_ENRICH_MAX_PER_FIRE).toBe("10");
    expect(fetchEnv.CLOUDFLARE_ACCOUNT_ID).toBe(env.CLOUDFLARE_ACCOUNT_ID);
    expect(fetchEnv.CLOUDFLARE_API_TOKEN).toBe(env.CLOUDFLARE_API_TOKEN);
  });

  it("forwards the OpenRouter lane vars", async () => {
    const env = buildRouteEnv();
    const fetchEnv = await buildFetchOneEnv(env);
    expect(fetchEnv.SUMMARIZE_MODEL).toBe("deepseek/deepseek-v4-flash");
    expect(fetchEnv.FEED_ENRICH_MODEL).toBe("deepseek/deepseek-v4-flash");
    expect(fetchEnv.MARKETING_CLASSIFIER_MODEL).toBe("google/gemini-2.5-flash-lite");
  });
});

describe("resolveArticleExtractModel over the builder's output (#2171)", () => {
  it("resolves a usable model when buildFetchOneEnv forwarded the Anthropic key", async () => {
    const env = buildRouteEnv();
    const fetchEnv = await buildFetchOneEnv(env);
    const model = await resolveArticleExtractModel(fetchEnv);
    expect(model).not.toBeNull();
  });

  it("reproduces the pre-fix silent failure: the old inline literal's shape (zero AI-lane keys) resolves to null", async () => {
    // Mirrors exactly what routes/sources.ts used to hand-build at its fetchOne
    // call site — every field present is a plain binding, none of them AI-lane.
    const oldLiteralShape: WorkflowFetchEnv = {
      GITHUB_TOKEN: secret("gh-test"),
      RELEASES_INDEX: {} as never,
      CHANGELOG_CHUNKS_INDEX: {} as never,
      EMBEDDING_PROVIDER: "voyage",
      VOYAGE_API_KEY: secret("voyage-test"),
      OPENAI_API_KEY: secret("openai-test"),
      RELEASE_HUB: {} as never,
      WEBHOOK_DELIVERY_QUEUE: {} as never,
      DB: {} as never,
      DETERMINISTIC_UPDATE_WORKFLOW: {} as never,
      SOURCE_ACTOR: {} as never,
      STATUS_HUB: {} as never,
      LATEST_CACHE: {} as never,
      MA_SESSIONS_DISABLED: undefined,
      MA_DAILY_SPEND_CAP_ORG_CENTS: undefined,
      MA_DAILY_SPEND_CAP_GLOBAL_CENTS: undefined,
      MEDIA: {} as never,
      FLAGS: undefined,
      // No ANTHROPIC_API_KEY, no OPENROUTER_*, no FEED_ENRICH_MODEL — the drop.
    } as unknown as WorkflowFetchEnv;
    const model = await resolveArticleExtractModel(oldLiteralShape);
    expect(model).toBeNull();
  });
});
