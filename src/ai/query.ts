import { config } from "../lib/config.js";
import { AIError } from "../lib/errors.js";
import { logUsage } from "../lib/usage.js";
import { getAnthropicClient } from "./client.js";

export interface ReleaseInput {
  title: string;
  content: string;
  version?: string;
  publishedAt?: string;
}

export function toReleaseInput(r: {
  title: string;
  content: string;
  version: string | null;
  publishedAt: string | null;
}): ReleaseInput {
  return {
    title: r.title,
    content: r.content,
    version: r.version ?? undefined,
    publishedAt: r.publishedAt ?? undefined,
  };
}

export async function summarizeReleases(releases: ReleaseInput[]): Promise<string> {
  const client = getAnthropicClient();

  const releasesText = releases
    .map((r) => {
      const header = [r.title, r.version, r.publishedAt].filter(Boolean).join(" | ");
      return `## ${header}\n${r.content}`;
    })
    .join("\n\n---\n\n");

  try {
    const response = await client.messages.create({
      model: config.queryModel(),
      max_tokens: 2048,
      system:
        "You summarize software release notes. Provide a concise, human-readable summary that highlights the most important changes, new features, bug fixes, and breaking changes. Group related changes together. Use bullet points for clarity.",
      messages: [
        {
          role: "user",
          content: `Summarize these releases:\n\n${releasesText}`,
        },
      ],
    });

    await logUsage({
      operation: "summarize",
      model: config.queryModel(),
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
