import { config } from "../lib/config.js";
import { AIError } from "../lib/errors.js";
import { getAnthropicClient } from "./client.js";

export interface ParsedRelease {
  version?: string;
  title: string;
  content: string;
  publishedAt?: string; // ISO 8601
  isBreaking: boolean;
}

const extractReleasesTool = {
  name: "extract_releases" as const,
  description: "Extract structured release entries from changelog markdown.",
  input_schema: {
    type: "object" as const,
    properties: {
      releases: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            version: {
              type: "string" as const,
              description: "Version number or tag (e.g. v1.2.3). Omit if not present.",
            },
            title: {
              type: "string" as const,
              description: "Title of the release entry.",
            },
            content: {
              type: "string" as const,
              description:
                "Full content of the release in markdown. Preserve image URLs as markdown image links.",
            },
            publishedAt: {
              type: "string" as const,
              description: "Publication date in ISO 8601 format. Omit if not present.",
            },
            isBreaking: {
              type: "boolean" as const,
              description: "Whether this release contains breaking changes.",
            },
          },
          required: ["title", "content", "isBreaking"],
        },
      },
    },
    required: ["releases"],
  },
};

const SYSTEM_PROMPT = `You are a changelog parser. Given raw markdown from a changelog or release notes page, extract individual release entries using the extract_releases tool.

Rules:
- Parse the markdown into individual release entries. A page may contain a single release or an entire changelog history with many releases.
- For each release, extract the version, title, full content, publication date, and whether it contains breaking changes.
- Preserve image URLs as markdown image links in the content field.
- If a date is present, convert it to ISO 8601 format (YYYY-MM-DD or full datetime).
- Mark isBreaking as true if the release mentions breaking changes, deprecations that remove functionality, or backwards-incompatible changes.
- If no version is explicitly stated, omit the version field.
- Always call the extract_releases tool with your results.`;

export async function parseChangelog(markdown: string): Promise<ParsedRelease[]> {
  const client = getAnthropicClient();

  try {
    const response = await client.messages.create({
      model: config.ingestModel(),
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: [extractReleasesTool],
      tool_choice: { type: "tool", name: "extract_releases" },
      messages: [
        {
          role: "user",
          content: `Parse the following changelog markdown into structured release entries:\n\n${markdown}`,
        },
      ],
    });

    const toolBlock = response.content.find((block) => block.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      throw new AIError("Model did not return a tool_use response.");
    }

    const input = toolBlock.input as Record<string, unknown>;
    if (!input || !Array.isArray(input.releases)) {
      throw new AIError("Model returned malformed tool_use response: missing releases array.");
    }
    return input.releases as ParsedRelease[];
  } catch (error) {
    if (error instanceof AIError) throw error;
    throw new AIError(
      `Failed to parse changelog: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined,
    );
  }
}
