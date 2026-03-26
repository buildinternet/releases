import { config } from "../lib/config.js";
import { AIError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
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
                "Full content of the release in markdown. Keep it concise — summarize long entries to their key changes. Preserve image URLs as markdown image links.",
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
- For each release, extract the version, title, content, publication date, and whether it contains breaking changes.
- For the content field, keep it concise: include the key changes, features, and fixes but summarize verbose entries. Do not reproduce the entire raw text.
- Preserve image URLs as markdown image links in the content field.
- If a date is present, convert it to ISO 8601 format (YYYY-MM-DD or full datetime).
- Mark isBreaking as true if the release mentions breaking changes, deprecations that remove functionality, or backwards-incompatible changes.
- If no version is explicitly stated, omit the version field.
- Always call the extract_releases tool with your results.`;

// Split markdown into chunks at heading boundaries (##, ###, ---)
// so each chunk is a self-contained section the model can parse.
function chunkMarkdown(markdown: string, maxChunkChars = 15_000): string[] {
  if (markdown.length <= maxChunkChars) return [markdown];

  const chunks: string[] = [];
  // Split on ## headings or --- dividers that commonly separate changelog entries
  const sections = markdown.split(/(?=^#{1,3}\s|\n---\n)/m);

  let current = "";
  for (const section of sections) {
    if (current.length + section.length > maxChunkChars && current.length > 0) {
      chunks.push(current);
      current = section;
    } else {
      current += section;
    }
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

async function parseChunk(client: ReturnType<typeof getAnthropicClient>, chunk: string): Promise<ParsedRelease[]> {
  const response = await client.messages.create({
    model: config.ingestModel(),
    max_tokens: 16384,
    system: SYSTEM_PROMPT,
    tools: [extractReleasesTool],
    tool_choice: { type: "tool", name: "extract_releases" },
    messages: [
      {
        role: "user",
        content: `Parse the following changelog markdown into structured release entries:\n\n${chunk}`,
      },
    ],
  });

  logger.debug(`AI ingest chunk (${chunk.length} chars) stop_reason:`, response.stop_reason);

  if (response.stop_reason === "max_tokens") {
    logger.warn("AI ingest hit max_tokens — chunk may be too large, some entries may be lost");
  }

  const toolBlock = response.content.find((block) => block.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    logger.debug("AI ingest response content:", JSON.stringify(response.content));
    return [];
  }

  const input = toolBlock.input as Record<string, unknown>;
  if (!input || !Array.isArray(input.releases)) {
    logger.debug("AI ingest tool_use input:", JSON.stringify(input));
    return [];
  }

  return input.releases as ParsedRelease[];
}

export async function parseChangelog(markdown: string): Promise<ParsedRelease[]> {
  const client = getAnthropicClient();
  const chunks = chunkMarkdown(markdown);

  logger.debug(`Parsing changelog: ${markdown.length} chars in ${chunks.length} chunk(s)`);

  const allReleases: ParsedRelease[] = [];

  for (const chunk of chunks) {
    try {
      const releases = await parseChunk(client, chunk);
      allReleases.push(...releases);
    } catch (error) {
      logger.warn(
        `Failed to parse chunk (${chunk.length} chars):`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (allReleases.length === 0 && chunks.length > 0) {
    throw new AIError("Failed to parse any release entries from the changelog.");
  }

  return allReleases;
}
