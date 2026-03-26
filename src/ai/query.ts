import { config } from "../lib/config.js";
import { AIError } from "../lib/errors.js";
import { logUsage } from "../lib/usage.js";
import { getAnthropicClient } from "./client.js";

export interface ReleaseInput {
  title: string;
  content: string;
  version?: string;
  publishedAt?: string;
  url?: string;
}

export function toReleaseInput(r: {
  title: string;
  content: string;
  version: string | null;
  publishedAt: string | null;
  url: string | null;
}): ReleaseInput {
  return {
    title: r.title,
    content: r.content,
    version: r.version ?? undefined,
    publishedAt: r.publishedAt ?? undefined,
    url: r.url ?? undefined,
  };
}

export async function summarizeReleases(
  releases: ReleaseInput[],
  options?: { instructions?: string },
): Promise<string> {
  const client = getAnthropicClient();

  const releasesText = releases
    .map((r) => {
      const header = [r.title, r.version, r.publishedAt].filter(Boolean).join(" | ");
      const urlLine = r.url ? `\nSource: ${r.url}` : "";
      return `## ${header}${urlLine}\n${r.content}`;
    })
    .join("\n\n---\n\n");

  const extraInstruction = options?.instructions
    ? `\nAdditional instructions from the reader: ${options.instructions}`
    : "";

  try {
    const response = await client.messages.create({
      model: config.ingestModel(),
      max_tokens: 1024,
      system: [
        "You write brief executive summaries of software release notes.",
        "Structure: Start with a 1-2 sentence overview of the release focus and trends across all releases. Then cover each release with a one-line headline and at most 3 bullets. Omit minor bug fixes entirely.",
        "Brevity: Compress aggressively — aim for 1/5th the input length. Name changes and move on; never reproduce full details.",
        "Sources: When a release has a source URL, include it as a markdown link on the release heading so the reader can follow up.",
        "Tone: Plain language, not marketing copy.",
      ].join("\n"),
      messages: [
        {
          role: "user",
          content: `Summarize these releases. Be very brief — the reader wants the gist, not the full changelog.${extraInstruction}\n\n${releasesText}`,
        },
      ],
    });

    await logUsage({
      operation: "summarize",
      model: config.ingestModel(),
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      releaseCount: releases.length,
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new AIError("Model did not return a text response.");
    }
    return textBlock.text;
  } catch (error) {
    if (error instanceof AIError) throw error;
    throw new AIError(
      `Failed to summarize releases: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined,
    );
  }
}

export async function compareProducts(
  productA: { name: string; releases: ReleaseInput[] },
  productB: { name: string; releases: ReleaseInput[] },
): Promise<string> {
  const client = getAnthropicClient();

  function formatReleases(product: { name: string; releases: ReleaseInput[] }): string {
    const entries = product.releases
      .map((r) => {
        const header = [r.title, r.version, r.publishedAt].filter(Boolean).join(" | ");
        return `## ${header}\n${r.content}`;
      })
      .join("\n\n");
    return `# ${product.name}\n\n${entries}`;
  }

  try {
    const response = await client.messages.create({
      model: config.queryModel(),
      max_tokens: 2048,
      system:
        "You compare recent changes between two software products. Provide a structured comparison covering: new features, bug fixes, performance improvements, and breaking changes. Note where the products overlap or diverge. Be concise and use markdown formatting.",
      messages: [
        {
          role: "user",
          content: `Compare recent changes between these two products:\n\n${formatReleases(productA)}\n\n---\n\n${formatReleases(productB)}`,
        },
      ],
    });

    await logUsage({
      operation: "compare",
      model: config.queryModel(),
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      releaseCount: productA.releases.length + productB.releases.length,
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new AIError("Model did not return a text response.");
    }
    return textBlock.text;
  } catch (error) {
    if (error instanceof AIError) throw error;
    throw new AIError(
      `Failed to compare products: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined,
    );
  }
}
