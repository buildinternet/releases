import Anthropic from "@anthropic-ai/sdk";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { logUsage } from "../lib/usage.js";
import { getAnthropicClient } from "./client.js";
import { getKnownReleasesForSource, type KnownRelease } from "../db/queries.js";
import type { ParsedRelease } from "./ingest.js";
import { sanitizeVersion, releaseItemProperties, releaseItemRequired } from "./shared.js";

// ── Tool schemas ────────────────────────────────────────────────────

const knownReleasesTool: Anthropic.Tool = {
  name: "known_releases",
  description:
    "Returns the most recent releases we already have for this source. Use this to determine where new content starts.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

const searchContentTool: Anthropic.Tool = {
  name: "search_content",
  description:
    "Search the changelog markdown for a text pattern. Returns matching line numbers with surrounding context. Use to find where a known version appears in the document.",
  input_schema: {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string" as const,
        description: "Text to search for (exact substring match, case-insensitive).",
      },
    },
    required: ["pattern"],
  },
};

const readLinesTool: Anthropic.Tool = {
  name: "read_lines",
  description:
    "Read a range of lines from the changelog markdown. Line numbers are 1-based.",
  input_schema: {
    type: "object" as const,
    properties: {
      startLine: {
        type: "number" as const,
        description: "First line to read (1-based, inclusive).",
      },
      endLine: {
        type: "number" as const,
        description: "Last line to read (1-based, inclusive).",
      },
    },
    required: ["startLine", "endLine"],
  },
};

const extractReleasesTool: Anthropic.Tool = {
  name: "extract_releases",
  description: "Extract the NEW release entries you found. Only include releases not in the known_releases list.",
  input_schema: {
    type: "object" as const,
    properties: {
      releases: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: { ...releaseItemProperties },
          required: [...releaseItemRequired],
        },
      },
    },
    required: ["releases"],
  },
};

// ── System prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an incremental changelog parser. A changelog page has been updated since we last checked. Your job is to find and extract ONLY the new releases we don't already have.

The page content is available via search_content and read_lines tools. You do NOT have the full document in your context — use the tools to explore it efficiently.

Start by calling known_releases to see what we already have. Then use search_content and read_lines however you see fit to find any new entries in the document that aren't in our list. Changelogs vary widely — some use version numbers, some use dates, some use titles. Adapt your approach to whatever format you find.

Rules:
- Extract ONLY releases that are NOT in the known_releases list.
- Keep content concise: key changes, features, and fixes.
- Dates should be ISO 8601. If no date is found, omit publishedAt.
- Mark isBreaking only if the entry mentions breaking or backwards-incompatible changes.
- Always call extract_releases when you're done, even if the array is empty.
- If you genuinely cannot determine what's new vs. what we already have, return an empty array. The system will fall back to a full re-parse.`;

// ── Tool handlers ───────────────────────────────────────────────────

interface ToolContext {
  lines: string[];
  knownReleases: KnownRelease[] | null;
}

function handleKnownReleases(ctx: ToolContext): string {
  if (!ctx.knownReleases || ctx.knownReleases.length === 0) {
    return "No known releases for this source.";
  }

  const entries = ctx.knownReleases.map((r) => {
    const parts = [];
    if (r.version) parts.push(`version: ${r.version}`);
    parts.push(`title: ${r.title}`);
    if (r.publishedAt) parts.push(`date: ${r.publishedAt}`);
    return parts.join(", ");
  });

  return `Known releases (most recent first):\n${entries.map((e, i) => `${i + 1}. ${e}`).join("\n")}`;
}

function handleSearchContent(ctx: ToolContext, pattern: string): string {
  const lowerPattern = pattern.toLowerCase();
  const matches: string[] = [];
  const contextRadius = 2;

  for (let i = 0; i < ctx.lines.length; i++) {
    if (ctx.lines[i].toLowerCase().includes(lowerPattern)) {
      const start = Math.max(0, i - contextRadius);
      const end = Math.min(ctx.lines.length - 1, i + contextRadius);
      const snippet = ctx.lines
        .slice(start, end + 1)
        .map((l, j) => {
          const lineNum = start + j + 1;
          const marker = start + j === i ? " >>>" : "    ";
          return `${marker} ${lineNum}: ${l}`;
        })
        .join("\n");
      matches.push(snippet);

      if (matches.length >= 5) break;
    }
  }

  if (matches.length === 0) {
    return `No matches found for "${pattern}".`;
  }

  return `Found ${matches.length} match(es) for "${pattern}":\n\n${matches.join("\n\n")}`;
}

function handleReadLines(ctx: ToolContext, startLine: number, endLine: number): string {
  const maxReadSize = 200;
  const clampedStart = Math.max(1, startLine);
  const clampedEnd = Math.min(ctx.lines.length, endLine);

  if (clampedStart > clampedEnd) {
    return `Invalid range: startLine (${startLine}) must be <= endLine (${endLine}). Document has ${ctx.lines.length} lines.`;
  }

  if (clampedEnd - clampedStart + 1 > maxReadSize) {
    return `Requested range too large (${clampedEnd - clampedStart + 1} lines). Maximum is ${maxReadSize} lines. Use a smaller range.`;
  }

  const slice = ctx.lines.slice(clampedStart - 1, clampedEnd);
  return slice.map((l, i) => `${clampedStart + i}: ${l}`).join("\n");
}

// ── Agent loop ──────────────────────────────────────────────────────

export interface IncrementalParseResult {
  releases: ParsedRelease[];
  /** True if the agent found the boundary and completed normally (even with 0 new releases). False if it couldn't find the boundary. */
  boundaryFound: boolean;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export async function parseIncremental(
  markdown: string,
  sourceId: string,
  sourceSlug?: string,
  prefetchedKnownReleases?: KnownRelease[],
): Promise<IncrementalParseResult> {
  const client = getAnthropicClient();
  const lines = markdown.split("\n");
  const knownReleases = prefetchedKnownReleases ?? await getKnownReleasesForSource(sourceId, sourceSlug ?? "", 10);

  if (knownReleases.length === 0) {
    logger.debug("No known releases — skipping incremental, will use bulk");
    return { releases: [], boundaryFound: false, inputTokens: 0, outputTokens: 0, turns: 0 };
  }

  const ctx: ToolContext = { lines, knownReleases };

  const tools = [knownReleasesTool, searchContentTool, readLinesTool, extractReleasesTool];
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `The changelog page has been updated (${lines.length} lines total). Find and extract only the new releases.\n\nHere are the first 50 lines of the page to help you understand its structure:\n\n${lines.slice(0, 50).map((l, i) => `${i + 1}: ${l}`).join("\n")}`,
    },
  ];

  let totalInput = 0;
  let totalOutput = 0;
  let turns = 0;
  const maxTurns = 8;
  let extractedReleases: ParsedRelease[] | null = null;

  while (turns < maxTurns) {
    turns++;

    const response = await client.messages.create({
      model: config.ingestModel(),
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;

    // Process tool calls
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // Check for extract_releases in this response
    for (const block of toolUseBlocks) {
      if (block.name === "extract_releases") {
        const input = block.input as { releases?: ParsedRelease[] };
        if (input?.releases && Array.isArray(input.releases)) {
          extractedReleases = input.releases.map((r) => ({
            ...r,
            version: sanitizeVersion(r.version),
          }));
        } else {
          extractedReleases = [];
        }
      }
    }

    if (extractedReleases !== null) break;

    if (response.stop_reason === "end_turn") {
      logger.warn("Incremental agent ended without calling extract_releases");
      break;
    }

    if (response.stop_reason !== "tool_use") {
      logger.warn(`Incremental agent stopped with reason: ${response.stop_reason}`);
      break;
    }

    // Build tool results and continue
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => {
      let result: string;

      switch (block.name) {
        case "known_releases":
          result = handleKnownReleases(ctx);
          break;
        case "search_content": {
          const input = block.input as { pattern: string };
          result = handleSearchContent(ctx, input.pattern);
          break;
        }
        case "read_lines": {
          const input = block.input as { startLine: number; endLine: number };
          result = handleReadLines(ctx, input.startLine, input.endLine);
          break;
        }
        case "extract_releases":
          result = "Received.";
          break;
        default:
          result = `Unknown tool: ${block.name}`;
      }

      return { type: "tool_result" as const, tool_use_id: block.id, content: result };
    });

    messages.push({ role: "user", content: toolResults });
  }

  await logUsage({
    operation: "ingest-incremental",
    model: config.ingestModel(),
    inputTokens: totalInput,
    outputTokens: totalOutput,
    sourceSlug,
  });

  logger.info(
    `Incremental agent: ${extractedReleases?.length ?? 0} new release(s) in ${turns} turn(s) (${totalInput.toLocaleString()} in + ${totalOutput.toLocaleString()} out tokens)`,
  );

  return {
    releases: extractedReleases ?? [],
    boundaryFound: extractedReleases !== null,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    turns,
  };
}
