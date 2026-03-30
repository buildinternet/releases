import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "path";
import { existsSync, mkdirSync, symlinkSync } from "fs";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import type { Confidence } from "../lib/discover.js";

// ── Types ──────────────────────────────────────────────────────────

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

export interface ReleasedAgentOptions {
  prompt: string;
  domain?: string;
  githubOrg?: string;
  onProgress?: (text: string) => void;
  onToolUse?: (toolName: string, command?: string) => void;
}

// ── Constants ──────────────────────────────────────────────────────

export const DISCOVERY_STATE_FILE = "/tmp/discovery-state.json";
const projectRoot = resolve(import.meta.dir, "../..");
const cliCmd = `bun ${projectRoot}/src/index.ts`;

// ── System prompt ──────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You manage changelog sources for Released. You find, evaluate, add, fetch, and validate changelog sources using the Released CLI.

You have access to the Released CLI at: ${cliCmd}

## Available Commands

- list [slug] [--json] [--org <org>]: Show indexed sources
- evaluate <url> [--json]: Evaluate a URL for the best ingestion method
- discover <domain> [--json]: Probe a domain for changelog URLs, feeds, and GitHub repos
- add <name> --url <url> [--type <type>] [--org <org>] [--feed-url <url>] [--skip-eval] [--batch <file>]: Add source(s)
- fetch <slug> [--dry-run] [--max <n>] [--full] [--crawl] [--no-crawl]: Fetch releases for a source
- fetch-log <slug>: Show recent fetch history
- remove <slug> [--ignore --reason <reason>]: Remove a source (use --ignore to prevent re-discovery)
- ignore list --org <org> --json: Show ignored URLs for an organization
- ignore add --org <org> <url>: Ignore a URL for an org
- block list --json: Show globally blocked URLs/domains
- block add <url>: Block a URL globally

## Subagents

Delegate CLI tasks to the "bulk-worker" subagent when you need to run multiple commands in parallel (e.g., validating several sources with dry-run fetches).

## Output

Keep your output concise — focus on actions and results.
Do NOT actually fetch (without --dry-run) unless explicitly told to.

IMPORTANT: At the end of discovery tasks, write a JSON state file to ${DISCOVERY_STATE_FILE} with this schema:
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

// ── Skills setup ───────────────────────────────────────────────────

/** Ensure agent skills are discoverable at .claude/skills/ relative to projectRoot. */
function ensureSkillsDiscoverable(): void {
  const skillsTarget = resolve(projectRoot, ".claude/skills");
  if (existsSync(skillsTarget)) return;

  // Skills live in src/agent/skills/ — symlink into .claude/skills/ for the SDK
  const skillsSource = resolve(projectRoot, "src/agent/skills");
  if (!existsSync(skillsSource)) return;

  mkdirSync(resolve(projectRoot, ".claude"), { recursive: true });
  symlinkSync(skillsSource, skillsTarget);
  logger.debug(`Symlinked agent skills: ${skillsSource} → ${skillsTarget}`);
}

// ── Agent ──────────────────────────────────────────────────────────

export async function runAgent(options: ReleasedAgentOptions): Promise<DiscoveryState> {
  const apiKey = config.anthropicApiKey();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required to run the Released agent");
  }

  ensureSkillsDiscoverable();

  const model = config.agentModel();
  const systemPrompt = buildSystemPrompt();

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

  logger.info(`Starting Released agent (model: ${model})`);

  const conversation = query({
    prompt: options.prompt,
    options: {
      model,
      cwd: projectRoot,
      systemPrompt,
      settingSources: ["project"],
      permissionMode: "acceptEdits",
      maxTurns: 30,
      maxBudgetUsd: 2.0,
      tools: { type: "preset", preset: "claude_code" } as const,
      allowedTools: [
        "Skill", "Bash", "Read", "Write",
        "Glob", "Grep", "WebSearch", "WebFetch",
      ],
      mcpServers: mcpServers as Record<string, import("@anthropic-ai/claude-agent-sdk").McpServerConfig>,
      agents: {
        "bulk-worker": {
          description:
            "Runs a Released CLI command and reports the result. Use for parallel validation, dry-run fetches, or any CLI task that doesn't need judgment.",
          prompt: `Run the given Released CLI command, evaluate the output, and report back with a structured summary including: command run, exit code, key findings (release count, errors, quality assessment).`,
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
        `Released agent complete — session: ${message.session_id}, cost: $${(message.total_cost_usd ?? 0).toFixed(4)}, turns: ${message.num_turns ?? "?"}`,
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
      product: options.domain ?? "unknown",
      domain: options.domain,
      githubOrg: options.githubOrg,
      startedAt: now,
      updatedAt: now,
      status: "awaiting_review",
      sources: [],
    };
  }
}

// ── Backward-compatible discovery wrapper ──────────────────────────

export interface DiscoveryOptions {
  company: string;
  domain?: string;
  githubOrg?: string;
  onProgress?: (text: string) => void;
  onToolUse?: (toolName: string, command?: string) => void;
}

export async function runDiscovery(options: DiscoveryOptions): Promise<DiscoveryState> {
  const hints: string[] = [];
  if (options.domain) hints.push(`Their website is ${options.domain}.`);
  if (options.githubOrg) hints.push(`Their GitHub organization is ${options.githubOrg}.`);
  const hintStr = hints.length > 0 ? " " + hints.join(" ") : "";

  const prompt = `Find and evaluate changelog sources for "${options.company}".${hintStr} Check what we already have, discover new sources, validate them with dry-run fetches, and write the discovery state file. Do not persist any fetches — dry-run only.`;

  return runAgent({
    prompt,
    domain: options.domain,
    githubOrg: options.githubOrg,
    onProgress: options.onProgress,
    onToolUse: options.onToolUse,
  });
}
