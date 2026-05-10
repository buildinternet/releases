#!/usr/bin/env bun
/**
 * Cross-provider evaluation for release-content generation (issue #851).
 *
 * Read-only. Fetches a fixed sample of releases from prod D1, runs each
 * through every configured provider with the production system prompt,
 * and prints a side-by-side comparison so the operator can audit
 * priority-order accuracy and smart-brevity adherence by eye while
 * quantitative metrics (token cost, latency, char-cap compliance) are
 * computed mechanically.
 *
 * Never writes to D1. Pure measurement tool.
 *
 * Usage:
 *   bun scripts/eval-release-content-providers.ts                       # default 10 releases past 30d
 *   bun scripts/eval-release-content-providers.ts --n=3                 # smaller sample
 *   bun scripts/eval-release-content-providers.ts --providers=anthropic-haiku,openai-mini
 *   bun scripts/eval-release-content-providers.ts --since=14            # past 14 days
 *
 * Provider scope: only providers Cloudflare AI Gateway can front, so flipping
 * to gateway-routed later is a one-line baseURL change. Kimi K2 ships via
 * Groq's hosting (Groq is in the gateway's supported list; Moonshot direct
 * is not).
 *
 * Required env (set whichever providers you want to include):
 *   ANTHROPIC_API_KEY    — for anthropic-haiku
 *   OPENAI_API_KEY       — for openai-mini
 *   GROQ_API_KEY         — for groq-kimi    (hosts moonshotai/kimi-k2-instruct)
 *   DEEPSEEK_API_KEY     — for deepseek     (deepseek-chat / V3 family)
 *
 * Model ID overrides (defaults shown — reset via env when provider-side IDs shift):
 *   ANTHROPIC_MODEL=claude-haiku-4-5
 *   OPENAI_MODEL=gpt-5-mini
 *   GROQ_MODEL=moonshotai/kimi-k2-instruct
 *   DEEPSEEK_MODEL=deepseek-chat
 *
 * Pricing in this script is list-price approximation as of 2026-05-09 —
 * verify with each provider's pricing page before quoting in roadmap docs.
 */

import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { logger } from "@buildinternet/releases-lib/logger";
import {
  MAX_OUTPUT_TOKENS,
  SYSTEM_PROMPT,
  buildReleaseBlock,
  extractTagged,
  isEmptyContent,
} from "@releases/ai-internal/release-content";

// ─── CLI args ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined =>
  argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");

const sampleSize = Number.parseInt(arg("n") ?? "10", 10);
const sinceDays = Number.parseInt(arg("since") ?? "30", 10);
const providersFilter = arg("providers")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (Number.isNaN(sampleSize) || sampleSize < 1) {
  logger.error("--n must be a positive integer");
  process.exit(1);
}
if (Number.isNaN(sinceDays) || sinceDays < 1) {
  logger.error("--since must be a positive integer");
  process.exit(1);
}

// ─── Provider config ─────────────────────────────────────────────────────────

// Limited to providers that Cloudflare AI Gateway can front (per its supported
// provider list as of 2026-05-09: Anthropic, OpenAI, Groq, DeepSeek, …). Calls
// are direct today; switching to gateway-routed is a one-line baseURL flip when
// we want unified observability. Kimi K2 ships via Groq's hosting; Moonshot
// direct + Z.ai direct were dropped because neither is in the gateway's
// provider list and OpenRouter detours add a hop without adding signal.
type ProviderId = "anthropic-haiku" | "openai-mini" | "groq-kimi" | "deepseek";

interface ProviderConfig {
  id: ProviderId;
  label: string;
  model: string;
  apiKey: string | undefined;
  // Pricing per 1M tokens, USD list (rough — see header comment).
  inputPricePerM: number;
  outputPricePerM: number;
  // OpenAI-compat baseURL; absent for Anthropic which uses its own SDK.
  baseURL?: string;
}

const PROVIDERS: ProviderConfig[] = [
  {
    id: "anthropic-haiku",
    label: "Anthropic Haiku 4.5",
    model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5",
    apiKey: process.env.ANTHROPIC_API_KEY,
    inputPricePerM: 1.0,
    outputPricePerM: 5.0,
  },
  {
    id: "openai-mini",
    label: "OpenAI GPT-5-mini",
    model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: "https://api.openai.com/v1",
    inputPricePerM: 0.25,
    outputPricePerM: 2.0,
  },
  {
    id: "groq-kimi",
    label: "Groq · Kimi K2 Instruct",
    model: process.env.GROQ_MODEL ?? "moonshotai/kimi-k2-instruct",
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
    inputPricePerM: 1.0,
    outputPricePerM: 3.0,
  },
  {
    id: "deepseek",
    label: "DeepSeek V3",
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com/v1",
    inputPricePerM: 0.27,
    outputPricePerM: 1.1,
  },
];

const enabled = PROVIDERS.filter((p) => {
  if (providersFilter && !providersFilter.includes(p.id)) return false;
  if (!p.apiKey) {
    logger.warn(`skipping ${p.id} — no API key in env`);
    return false;
  }
  return true;
});

if (enabled.length === 0) {
  logger.error("no providers enabled (check API keys + --providers filter)");
  process.exit(1);
}

logger.info(`enabled providers: ${enabled.map((p) => p.id).join(", ")}`);

// ─── D1 sampling ─────────────────────────────────────────────────────────────

interface ReleaseRow {
  id: string;
  title: string;
  version: string | null;
  content: string;
  url: string | null;
  org_slug: string;
  source_name: string;
  product_name: string | null;
}

function runWrangler(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bunx", ["wrangler", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`wrangler exit ${code}: ${stderr}`));
      else resolve(stdout);
    });
  });
}

async function fetchSample(): Promise<ReleaseRow[]> {
  const cutoffIso = daysAgoIso(sinceDays);
  // Bias toward releases with non-trivial bodies; deterministic ordering
  // by id keeps reruns comparable across days.
  const sql = `
    SELECT r.id, r.title, r.version, r.content, r.url,
           o.slug as org_slug,
           s.name as source_name,
           p.name as product_name
    FROM releases r
    JOIN sources s ON s.id = r.source_id
    JOIN organizations o ON o.id = s.org_id
    LEFT JOIN products p ON p.id = s.product_id
    WHERE r.suppressed = 0
      AND s.is_hidden = 0
      AND r.fetched_at >= '${cutoffIso}'
      AND LENGTH(r.content) > 200
    ORDER BY r.id
    LIMIT ${sampleSize * 4};
  `.trim();

  const out = await runWrangler([
    "d1",
    "execute",
    "released-db",
    "--remote",
    "--config",
    "workers/api/wrangler.jsonc",
    "--command",
    sql,
    "--json",
  ]);

  const start = out.indexOf("[");
  if (start === -1) throw new Error(`no JSON in wrangler output: ${out}`);
  const parsed = JSON.parse(out.slice(start)) as Array<{ results: ReleaseRow[] }>;
  const all = parsed[0]?.results ?? [];

  // Drop empty-content rows that would short-circuit before any provider
  // call — they tell us nothing about quality.
  const nonEmpty = all.filter((r) => !isEmptyContent(r.content));

  // Diverse sample: spread evenly across the candidate pool so we don't
  // load the eval with consecutive releases from one source.
  if (nonEmpty.length <= sampleSize) return nonEmpty;
  const stride = nonEmpty.length / sampleSize;
  return Array.from({ length: sampleSize }, (_, i) => nonEmpty[Math.floor(i * stride)]!);
}

// ─── Provider call paths ─────────────────────────────────────────────────────

interface ProviderResult {
  ok: boolean;
  rawText: string;
  title: string;
  titleShort: string;
  summary: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
}

async function callAnthropic(cfg: ProviderConfig, userBlock: string): Promise<ProviderResult> {
  const start = Date.now();
  const client = new Anthropic({ apiKey: cfg.apiKey! });
  try {
    const res = await client.messages.create({
      model: cfg.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userBlock }],
    });
    const raw = res.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      ok: true,
      rawText: raw,
      title: extractTagged(raw, "title"),
      titleShort: extractTagged(raw, "title_short"),
      summary: extractTagged(raw, "summary"),
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      rawText: "",
      title: "",
      titleShort: "",
      summary: "",
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
}

async function callOpenAICompat(cfg: ProviderConfig, userBlock: string): Promise<ProviderResult> {
  const start = Date.now();
  try {
    const res = await fetch(`${cfg.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userBlock },
        ],
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    const raw = data.choices[0]?.message?.content ?? "";
    return {
      ok: true,
      rawText: raw,
      title: extractTagged(raw, "title"),
      titleShort: extractTagged(raw, "title_short"),
      summary: extractTagged(raw, "summary"),
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      rawText: "",
      title: "",
      titleShort: "",
      summary: "",
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
}

async function callProvider(cfg: ProviderConfig, userBlock: string): Promise<ProviderResult> {
  if (cfg.id === "anthropic-haiku") return callAnthropic(cfg, userBlock);
  return callOpenAICompat(cfg, userBlock);
}

// ─── Quality heuristics ──────────────────────────────────────────────────────

const SMART_BREVITY_LEAD_VIOLATIONS = /^(adds?|fixes?|improves?|updates?|introduces?|enables?)\b/i;

interface QualityFlags {
  titleOver100: boolean;
  shortOver70: boolean;
  shortLeadsWithVerb: boolean;
  missingAnyTag: boolean;
}

function score(r: ProviderResult): QualityFlags {
  return {
    titleOver100: r.title.length > 100,
    shortOver70: r.titleShort.length > 70,
    shortLeadsWithVerb: SMART_BREVITY_LEAD_VIOLATIONS.test(r.titleShort),
    missingAnyTag: !r.title || !r.titleShort || !r.summary,
  };
}

function costUsd(cfg: ProviderConfig, r: ProviderResult): number {
  return (
    (r.inputTokens * cfg.inputPricePerM) / 1_000_000 +
    (r.outputTokens * cfg.outputPricePerM) / 1_000_000
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

logger.info(`fetching sample (n=${sampleSize}, since=${sinceDays}d)…`);
const releases = await fetchSample();
logger.info(`got ${releases.length} releases`);

interface RowResult {
  release: ReleaseRow;
  byProvider: Map<ProviderId, ProviderResult>;
}

const rowResults: RowResult[] = [];

for (const release of releases) {
  const userBlock = buildReleaseBlock({
    orgSlug: release.org_slug,
    sourceName: release.source_name,
    productName: release.product_name,
    title: release.title,
    version: release.version,
    url: release.url,
    content: release.content,
  });

  // Fan out across providers in parallel — independent calls. Outer loop
  // stays sequential so we don't blast all 4 providers × N releases at once.
  // eslint-disable-next-line no-await-in-loop -- intentional per-release pacing
  const results = await Promise.all(
    enabled.map(async (cfg) => [cfg.id, await callProvider(cfg, userBlock)] as const),
  );

  rowResults.push({ release, byProvider: new Map(results) });
  logger.info(
    `  ${release.org_slug}/${release.title.slice(0, 60)} — ${results
      .map(([id, r]) => `${id}:${r.ok ? `${r.durationMs}ms` : "ERR"}`)
      .join(" ")}`,
  );
}

// ─── Aggregate ───────────────────────────────────────────────────────────────

interface Aggregate {
  cfg: ProviderConfig;
  totalCost: number;
  totalInput: number;
  totalOutput: number;
  durations: number[];
  flags: QualityFlags[];
  errors: number;
}

const aggregates: Aggregate[] = enabled.map((cfg) => ({
  cfg,
  totalCost: 0,
  totalInput: 0,
  totalOutput: 0,
  durations: [],
  flags: [],
  errors: 0,
}));

for (const row of rowResults) {
  for (const agg of aggregates) {
    const r = row.byProvider.get(agg.cfg.id);
    if (!r) continue;
    if (!r.ok) {
      agg.errors++;
      continue;
    }
    agg.totalCost += costUsd(agg.cfg, r);
    agg.totalInput += r.inputTokens;
    agg.totalOutput += r.outputTokens;
    agg.durations.push(r.durationMs);
    agg.flags.push(score(r));
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${((n / d) * 100).toFixed(0)}%`;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  // eslint-disable-next-line unicorn/no-array-sort -- already operating on a copy via spread
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(arr.length * p))]!;
}

const lines: string[] = [
  "",
  "## Per-provider summary",
  "",
  "| provider | n | errors | mean tok in | mean tok out | p50 ms | p95 ms | total cost | title>100 | short>70 | short leads w/ verb | missing tag |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];

for (const agg of aggregates) {
  const n = agg.flags.length;
  const meanIn = n === 0 ? 0 : Math.round(agg.totalInput / n);
  const meanOut = n === 0 ? 0 : Math.round(agg.totalOutput / n);
  const p50 = percentile(agg.durations, 0.5);
  const p95 = percentile(agg.durations, 0.95);
  const titleOver = agg.flags.filter((f) => f.titleOver100).length;
  const shortOver = agg.flags.filter((f) => f.shortOver70).length;
  const shortLead = agg.flags.filter((f) => f.shortLeadsWithVerb).length;
  const missing = agg.flags.filter((f) => f.missingAnyTag).length;
  lines.push(
    `| ${agg.cfg.label} | ${n} | ${agg.errors} | ${meanIn} | ${meanOut} | ${p50} | ${p95} | $${agg.totalCost.toFixed(4)} | ${pct(titleOver, n)} | ${pct(shortOver, n)} | ${pct(shortLead, n)} | ${pct(missing, n)} |`,
  );
}

lines.push("", "## Side-by-side outputs", "");

for (const row of rowResults) {
  lines.push(
    `### ${row.release.org_slug} · ${row.release.title}${row.release.version ? ` (${row.release.version})` : ""}`,
    "",
    `_Body length: ${row.release.content.length} chars_`,
    "",
  );
  for (const cfg of enabled) {
    const r = row.byProvider.get(cfg.id);
    if (!r) continue;
    lines.push(
      `**${cfg.label}** _(${r.durationMs}ms, ${r.inputTokens} in / ${r.outputTokens} out)_`,
    );
    if (!r.ok) {
      lines.push(`  ERROR: ${r.error}`, "");
      continue;
    }
    lines.push(`  · title:       ${r.title || "(missing)"}`);
    lines.push(`  · title_short: ${r.titleShort || "(missing)"}`);
    lines.push(`  · summary:     ${r.summary || "(missing)"}`);
    lines.push("");
  }
}

logger.info(lines.join("\n"));
