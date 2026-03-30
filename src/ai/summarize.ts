import { getAnthropicClient } from "./client.js";
import { config } from "../lib/config.js";
import { logUsage } from "../lib/usage.js";
import type { Release } from "../db/schema.js";
import { logger } from "../lib/logger.js";

const DEFAULT_WINDOW_DAYS = 90;

interface SummaryInput {
  sourceName: string;
  sourceSlug: string;
  releases: Release[];
  windowDays?: number;
  type: "rolling" | "monthly";
  /** For monthly: "March 2026" */
  period?: string;
}

interface SummaryResult {
  summary: string;
  releaseCount: number;
}

const ROLLING_SYSTEM_PROMPT = `You are a technical analyst summarizing software release activity.

Given a list of releases from a software product, write a concise summary that:

1. Identifies THEMES and DIRECTIONAL TRENDS — not just a list of features
   - Good: "Significant investment in developer tooling, including multi-file editing and a new MCP integration"
   - Bad: "Three major features shipped: multi-file editing, MCP integration, and performance improvements"
2. Cites specific releases as evidence of themes when they add clarity
3. Scales your response length to the volume of activity:
   - Quiet period (1-3 releases): 1-2 sentences
   - Moderate activity (4-10 releases): 2-4 sentences
   - High activity (10+ releases): A short paragraph, possibly with thematic grouping
4. Emphasizes recency — what happened this week/month matters more than older releases
5. Calls out breaking changes or major version bumps if present

Write in third person, present tense. No headers, no bullet points, no markdown formatting — just clean prose.`;

const MONTHLY_SYSTEM_PROMPT = `You are a technical analyst writing a monthly archive summary of software release activity.

Given all releases from a specific month for a software product, write a concise summary that:

1. Identifies THEMES and DIRECTIONAL TRENDS for the month
2. Cites specific releases as evidence
3. Scales length to activity volume (1-2 sentences if quiet, a short paragraph if active)
4. Notes any breaking changes or major version bumps

Write in third person, past tense. No headers, no bullet points, no markdown formatting — just clean prose.`;

function formatReleasesForPrompt(releases: Release[]): string {
  return releases
    .map((r) => {
      const parts: string[] = [];
      if (r.version) parts.push(`Version: ${r.version}`);
      if (r.title) parts.push(`Title: ${r.title}`);
      if (r.publishedAt) parts.push(`Date: ${r.publishedAt}`);
      parts.push(`Content: ${r.content.slice(0, 1000)}`);
      return parts.join("\n");
    })
    .join("\n---\n");
}

export async function generateSummary(input: SummaryInput): Promise<SummaryResult | null> {
  const { sourceName, sourceSlug, releases, type, period } = input;

  if (releases.length === 0) {
    return null;
  }

  const client = getAnthropicClient();
  const model = config.summaryModel();
  const systemPrompt = type === "rolling" ? ROLLING_SYSTEM_PROMPT : MONTHLY_SYSTEM_PROMPT;

  const userMessage =
    type === "rolling"
      ? `Summarize the recent release activity for ${sourceName}. Here are the releases from the last ${input.windowDays ?? DEFAULT_WINDOW_DAYS} days:\n\n${formatReleasesForPrompt(releases)}`
      : `Summarize the release activity for ${sourceName} during ${period}:\n\n${formatReleasesForPrompt(releases)}`;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    await logUsage({
      operation: type === "rolling" ? "summary_rolling" : "summary_monthly",
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      sourceSlug,
      releaseCount: releases.length,
    });

    return {
      summary: text.trim(),
      releaseCount: releases.length,
    };
  } catch (err) {
    logger.error(`Failed to generate ${type} summary for ${sourceName}: ${err}`);
    return null;
  }
}

export { DEFAULT_WINDOW_DAYS };
