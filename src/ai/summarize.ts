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
  /** Brief product description to ground the summary for lesser-known products */
  orgDescription?: string;
}

interface SummaryResult {
  summary: string;
  releaseCount: number;
}

const ROLLING_SYSTEM_PROMPT = `You summarize what a software product has been shipping recently.

Write for a developer audience. Identify the thread — what direction is the product moving? Open with the theme, then mention 2-3 specifics that illustrate it. Don't list features; tell the story of where the product is going.

Guidelines:

1. Scale to how much actually happened:
   - Quiet period (1-3 releases): 1-2 sentences
   - Moderate activity (4-10 releases): 2-4 sentences
   - Busy period (10+ releases): 3-4 sentences
2. Call out breaking changes or major version bumps if present
3. Don't editorialize — no commentary on how "active" or "busy" the team has been, no judgments about strategy. Just describe what shipped and where it's heading.

Write in third person, present tense. No headers, no bullet points, no markdown — just plain prose.`;

const MONTHLY_SYSTEM_PROMPT = `You write monthly summaries of what a software product shipped.

Write for a developer audience. Identify the theme — what did this month move forward? Open with the direction, then name 1-2 specifics that illustrate it. Don't list features; tell the story of what the month was about.

Guidelines:

1. Scale length to how much happened (1-2 sentences if quiet, 2-3 sentences if busy)
2. Note any breaking changes or major version bumps
3. Don't editorialize — no commentary on how active the team was, no judgments about strategy. Just describe what shipped.

Write in third person, past tense. No headers, no bullet points, no markdown — just plain prose.`;

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
  const { sourceName, sourceSlug, releases, type, period, orgDescription } = input;

  if (releases.length === 0) {
    return null;
  }

  const client = getAnthropicClient();
  const model = config.summaryModel();
  const systemPrompt = type === "rolling" ? ROLLING_SYSTEM_PROMPT : MONTHLY_SYSTEM_PROMPT;

  const productLabel = orgDescription?.trim() ? `${sourceName} (${orgDescription.trim()})` : sourceName;

  const userMessage =
    type === "rolling"
      ? `Summarize the recent release activity for ${productLabel}. Here are the releases from the last ${input.windowDays ?? DEFAULT_WINDOW_DAYS} days:\n\n${formatReleasesForPrompt(releases)}`
      : `Summarize the release activity for ${productLabel} during ${period}:\n\n${formatReleasesForPrompt(releases)}`;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
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
