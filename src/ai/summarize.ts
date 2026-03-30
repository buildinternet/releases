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

const ROLLING_SYSTEM_PROMPT = `You summarize what a software product has been shipping recently.

Write for a developer audience at a casual, approachable reading level. Keep it clear and direct — stick to what shipped and where the product is heading.

Guidelines:

1. Focus on what shipped — group related changes into themes rather than listing features one by one
   - Good: "Lots of work on developer tooling lately, including multi-file editing and a new MCP integration"
   - Bad: "Three major features shipped: multi-file editing, MCP integration, and performance improvements"
2. Mention specific features or releases when they help illustrate a theme
3. Scale your response to how much actually happened:
   - Quiet period (1-3 releases): 1-2 sentences
   - Moderate activity (4-10 releases): 2-4 sentences
   - Busy period (10+ releases): A short paragraph
4. Prioritize the most recent and most impactful changes
5. Call out breaking changes or major version bumps if present
6. Don't editorialize — no commentary on how "active" or "busy" the team has been, no judgments about strategy or positioning. Just describe what shipped.

Write in third person, present tense. No headers, no bullet points, no markdown — just plain prose.`;

const MONTHLY_SYSTEM_PROMPT = `You write monthly summaries of what a software product shipped.

Write for a developer audience at a casual, approachable reading level. Stick to what shipped.

Guidelines:

1. Group related changes into themes — what direction did the product move this month?
2. Mention specific features when they help illustrate the theme
3. Scale length to how much happened (1-2 sentences if quiet, a short paragraph if busy)
4. Note any breaking changes or major version bumps
5. Don't editorialize — no commentary on how active the team was, no judgments about strategy. Just describe what shipped.

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
