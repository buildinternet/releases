#!/usr/bin/env bun
/**
 * One-off smoke test for the tool-loop extraction path (#557). Fetches a
 * live URL, runs extractFromBody with useToolLoop: true, and prints the
 * result shape. Costs one Anthropic Sonnet call worth of tool-use tokens;
 * writes nothing to D1 or to source metadata.
 *
 * Usage:
 *   bun scripts/smoke-toolloop.ts <url>
 */

import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { extractFromBody } from "@releases/adapters/extract";
import { DIRECT_FETCH_SYSTEM_PROMPT } from "../packages/adapters/src/extract/shared.js";
import type { ExtractDeps, ExtractRepo } from "../packages/adapters/src/extract/types.js";

const url = process.argv[2];
if (!url) {
  console.error("Usage: bun scripts/smoke-toolloop.ts <url>");
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const res = await fetch(url, {
  headers: { "User-Agent": "Mozilla/5.0 releases-smoke-toolloop" },
});
if (!res.ok) {
  console.error(`Fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const body = await res.text();
console.error(`Fetched ${body.length.toLocaleString()} chars from ${url}`);

const noopRepo: ExtractRepo = {
  peekContentHash: async () => false,
  commitContentHash: async () => {},
  updateSourceMeta: async () => {},
  getOrgPlaybook: async () => null,
  logUsage: async () => {},
};

const deps: ExtractDeps = {
  // Route through the CF AI Gateway when ANTHROPIC_BASE_URL is set; direct when unset.
  anthropicClient: buildAnthropicClient({
    apiKey,
    baseURL: process.env.ANTHROPIC_BASE_URL,
    gatewayToken: process.env.AI_GATEWAY_TOKEN,
  }),
  agentModel: "claude-sonnet-5",
  logger: {
    info: (m) => console.error(`[info] ${m}`),
    warn: (m) => console.error(`[warn] ${m}`),
    debug: (m) => console.error(`[debug] ${m}`),
    error: (m) => console.error(`[error] ${m}`),
  },
  cloudflare: null,
  repo: noopRepo,
  extractToolLoopEnabled: true,
};

const result = await extractFromBody(
  {
    body,
    systemPrompt: DIRECT_FETCH_SYSTEM_PROMPT,
    userMessage: `Extract all changelog/release entries from this content (canonical source URL: ${url}, fetched from: ${url}):`,
    sourceUrl: url,
    fetchUrl: url,
    useToolLoop: true,
  },
  deps,
);

console.log(
  JSON.stringify(
    {
      mode: result.mode,
      toolRounds: result.toolRounds,
      toolChars: result.toolChars,
      fallbackReason: result.fallbackReason,
      hitMaxTokens: result.hitMaxTokens,
      totalInput: result.totalInput,
      totalOutput: result.totalOutput,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      entryCount: result.entries.length,
      firstFive: result.entries.slice(0, 5).map((e) => ({
        title: e.title,
        version: e.version,
        publishedAt: e.publishedAt,
      })),
    },
    null,
    2,
  ),
);
