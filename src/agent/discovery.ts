import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "path";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import type { Confidence } from "../lib/discover.js";

export interface AgentDiscoveredSource {
  url: string;
  type: "github" | "scrape" | "feed";
  slug: string;
  label: string;
  confidence: Confidence;
  validated: boolean;
  validationError?: string;
  releaseCount?: number;
  duplicateOf?: string;
  approved?: boolean;
  fetched?: boolean;
}

export interface DiscoveryState {
  product: string;
  domain?: string;
  githubOrg?: string;
  startedAt: string;
  updatedAt: string;
  status: "discovering" | "awaiting_review" | "approved" | "fetching" | "complete" | "error";
  sources: AgentDiscoveredSource[];
  agentSessionId?: string;
  costUsd?: number;
  turns?: number;
}

export interface DiscoveryOptions {
  company: string;
  domain?: string;
  githubOrg?: string;
  onProgress?: (text: string) => void;
  onToolUse?: (toolName: string, command?: string) => void;
}

const DISCOVERY_STATE_FILE = "/tmp/discovery-state.json";

const projectRoot = resolve(import.meta.dir, "../..");
const cliCmd = `bun ${projectRoot}/src/index.ts`;

function buildSystemPrompt(): string {
  return `You are a changelog discovery agent for the "Released" tool. Your job is to find and onboard changelog sources for a given company or product.

You have access to the Released CLI at: ${cliCmd}

Available commands:
- list: Show all indexed sources (use --json for machine-readable output)
- ignore list --json: Show all ignored URLs (these will never be re-added)
- discover <domain>: Probe a domain for changelog URLs, feeds, and GitHub repos
- add <url> --name <name> --type <type>: Add a new source (types: github, scrape, feed)
- add --batch <file>: Add multiple sources from a JSON file (array of {url, name, type})
- fetch <slug> --dry-run: Test fetching a source without persisting
- remove <slug1> <slug2> ... --ignore --reason <reason>: Remove sources and add their URLs to the ignore list

Your workflow:
0. Check ignored URLs with "ignore list --json" — skip any URLs that appear in the ignore list
1. Check what sources already exist with "list --json"
2. Use web search to find the company's main website, changelog pages, and GitHub organization
3. Use "discover" on the company's domain to find changelog surfaces
4. For any promising URLs found via search or discover, add them as sources
5. Use batch operations ("add --batch") when adding multiple sources at once — write the JSON array to a temp file, then pass it
6. Delegate validation to the "source-validator" subagent for each source (it runs "fetch --dry-run" and evaluates results)
7. Remove sources that don't extract well or are duplicates using "remove <slug> --ignore --reason <reason>" so they won't be re-discovered
8. Report your findings

When WebFetch returns empty or skeleton content (JS-rendered pages), use the render_markdown MCP tool to get the fully-rendered content.

Be methodical. If a source doesn't extract well, try a different URL or type.
Do NOT actually fetch (without --dry-run) unless explicitly told to.
Keep your output concise — focus on actions and results.

IMPORTANT: At the end of your work, write a JSON state file to ${DISCOVERY_STATE_FILE} with this exact schema:
{
  "product": "<company name>",
  "domain": "<discovered domain or null>",
  "githubOrg": "<discovered GitHub org or null>",
  "startedAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>",
  "status": "awaiting_review",
  "sources": [
    {
      "url": "<source url>",
      "type": "github|scrape|feed",
      "slug": "<slug from released add>",
      "label": "<human-readable label>",
      "confidence": "high|medium|low",
      "validated": true/false,
      "validationError": "<error message if validation failed>",
      "releaseCount": <number of releases found in dry-run>,
      "duplicateOf": "<slug if this overlaps another source>"
    }
  ]
}`;
}

export async function runDiscovery(options: DiscoveryOptions): Promise<DiscoveryState> {
  const apiKey = config.anthropicApiKey();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required to run the discovery agent");
  }

  const model = config.agentModel();
  const systemPrompt = buildSystemPrompt();

  const hints: string[] = [];
  if (options.domain) hints.push(`Their website is ${options.domain}.`);
  if (options.githubOrg) hints.push(`Their GitHub organization is ${options.githubOrg}.`);
  const hintStr = hints.length > 0 ? " " + hints.join(" ") : "";

  const prompt = `Find and evaluate changelog sources for "${options.company}".${hintStr} Check what we already have, discover new sources, validate them with dry-run fetches, and write the discovery state file. Do not persist any fetches — dry-run only.`;

  const mcpServers: Record<string, object> = {};
  const cfAccountId = config.cloudflareAccountId();
  const cfApiToken = config.cloudflareApiToken();
  if (cfAccountId && cfApiToken) {
    mcpServers["cloudflare-browser"] = {
      type: "stdio",
      command: "bun",
      args: [resolve(projectRoot, "src/agent/mcp-cloudflare-browser.ts")],
      env: {
        CLOUDFLARE_ACCOUNT_ID: cfAccountId,
        CLOUDFLARE_API_TOKEN: cfApiToken,
      },
    };
  }

  logger.info(`Starting discovery agent for "${options.company}" (model: ${model})`);

  const conversation = query({
    prompt,
    options: {
      model,
      cwd: projectRoot,
      systemPrompt,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 30,
      maxBudgetUsd: 2.0,
      tools: { type: "preset", preset: "claude_code" } as const,
      allowedTools: ["Bash", "Read", "Write", "Glob", "Grep", "WebSearch", "WebFetch"],
      mcpServers: mcpServers as Record<string, import("@anthropic-ai/claude-agent-sdk").McpServerConfig>,
      agents: {
        "source-validator": {
          description:
            "Validates a single changelog source by running fetch --dry-run and evaluating the results. Invoke with the source slug.",
          prompt: `You validate Released changelog sources. Given a source slug, run:
  ${cliCmd} fetch <slug> --dry-run

Evaluate the output:
- Did it find releases? How many?
- Do the releases have titles, dates, and content?
- Is this a real changelog/release page or something unrelated?

Report back with: slug, release count, quality assessment (good/partial/bad), and any issues.`,
          tools: ["Bash", "Read"],
          model: "haiku",
          maxTurns: 5,
        },
      },
    },
  });

  for await (const message of conversation) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          options.onProgress?.(block.text);
        } else if (block.type === "tool_use") {
          const command =
            block.name === "Bash" && typeof block.input === "object" && block.input !== null
              ? (block.input as Record<string, unknown>).command as string | undefined
              : undefined;
          options.onToolUse?.(block.name, command);
        }
      }
    } else if (message.type === "result") {
      logger.info(
        `Discovery agent complete — session: ${message.session_id}, cost: $${(message.total_cost_usd ?? 0).toFixed(4)}, turns: ${message.num_turns ?? "?"}`,
      );
    }
  }

  try {
    const raw = await Bun.file(DISCOVERY_STATE_FILE).text();
    const state: DiscoveryState = JSON.parse(raw);
    return state;
  } catch {
    logger.warn("Agent did not write a valid discovery state file — returning minimal state");
    const now = new Date().toISOString();
    return {
      product: options.company,
      domain: options.domain,
      githubOrg: options.githubOrg,
      startedAt: now,
      updatedAt: now,
      status: "awaiting_review",
      sources: [],
    };
  }
}
