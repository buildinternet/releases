import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, symlinkSync } from "fs";
import { config, resolveCLICmd } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import type { Confidence } from "../lib/discover.js";
import { CATEGORIES } from "../lib/categories.js";

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
  releasesFetched?: number;
  contentDepth?: "full" | "summary-only";
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
const cliCmd = resolveCLICmd();

// ── System prompt ──────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You manage changelog sources for Released. You find, evaluate, add, fetch, and validate changelog sources using the Released CLI.

You have access to the Released CLI at: ${cliCmd}

## Available Commands

- list [slug] [--json] [--org <org>] [--has-feed] [--enrichable]: Show indexed sources
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
- enrich <slug> [--dry-run] [--limit <n>] [--json]: Enrich sparse releases with full page content
- org add <name> [--domain <domain>] [--description <text>] [--slug <slug>] [--category <cat>] [--tags <t1,t2>]: Create an organization
- org edit <slug> [--category <cat>] [--no-category]: Edit an organization
- org show <slug>: Show org details
- org tag add <slug> <tag1> [tag2...]: Add tags to an organization
- org tag remove <slug> <tag1> [tag2...]: Remove tags from an organization
- product add <name> --org <org> [--category <cat>] [--tags <t1,t2>] [--url <url>] [--description <text>]: Create a product
- product edit <slug> [--category <cat>] [--no-category]: Edit a product
- product tag add <slug> <tag1> [tag2...]: Add tags to a product
- categories [--json]: List valid category values

When creating an organization, always include a --description with a brief one-sentence product description (e.g. "Event-driven durable workflow engine for TypeScript"). This is used to ground AI summaries for lesser-known products.

## Categories

Valid categories for organizations and products: ${CATEGORIES.join(", ")}

When onboarding, assign a category to the organization and to each product if multiple products are detected. Use --category on org add and product add. Use org tag add / product tag add for freeform tags describing tech stack, ecosystem, or use case.

## Multi-Product Organizations

Some organizations ship multiple distinct products (e.g., Vercel ships Next.js, Turborepo, v0). When you discover sources that clearly belong to different products:

- **High confidence** (separate GitHub repos, separate domains, distinct names): Create products using \`product add\` and assign sources using \`edit <source-slug> --product <product-slug>\`
- **Medium confidence** (some signals but ambiguous): Note the suggested product groupings in the state file under \`suggestedProducts\` but don't auto-create
- **Low confidence** (unclear): Leave sources at the org level

## Subagents

Delegate CLI tasks to the "bulk-worker" subagent when you need to run multiple commands in parallel (e.g., validating several sources with dry-run fetches, enriching multiple sources).

## Onboarding Workflow

When onboarding a new company, follow this sequence:

1. **Discover** — find changelog URLs, feeds, and GitHub repos
2. **Add** — add sources with appropriate types
3. **Validate** — dry-run fetch each source to check quality
4. **Fetch** — for validated sources, run a real fetch (without --dry-run) with --max 50 to seed initial releases
5. **Enrich feed sources** — after fetching, assess feed content depth and enrich sparse sources. See the "Feed Content Depth Assessment" section in the parsing-changelogs skill. Delegate enrichment to the bulk-worker subagent.

## Output

Keep your output concise — focus on actions and results.

IMPORTANT: At the end of discovery tasks, write a JSON state file to ${DISCOVERY_STATE_FILE} with this schema:
{
  "product": "<company name>",
  "domain": "<discovered domain or null>",
  "githubOrg": "<discovered GitHub org or null>",
  "category": "<org category>",
  "tags": ["<tag1>", "<tag2>"],
  "startedAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>",
  "status": "awaiting_review",
  "sources": [
    {
      "url": "<source url>",
      "type": "github|scrape|feed",
      "slug": "<slug from releases add>",
      "label": "<human-readable label>",
      "confidence": "high|medium|low",
      "validated": true/false,
      "validationError": "<error message if validation failed>",
      "releaseCount": <number of releases found in dry-run>,
      "releasesFetched": <number of releases actually persisted via real fetch>,
      "duplicateOf": "<slug if this overlaps another source>",
      "contentDepth": "full|summary-only (for feed/scrape sources, based on dry-run content length)",
      "productSlug": "<product slug if assigned to auto-created product>"
    }
  ],
  "suggestedProducts": [
    {
      "name": "<product name>",
      "confidence": "medium",
      "reason": "<why this is suggested>",
      "suggestedSources": ["<slug1>", "<slug2>"],
      "suggestedCategory": "<category>",
      "suggestedTags": ["<tag1>"]
    }
  ]
}`;
}

// ── Skills setup ───────────────────────────────────────────────────

/** Resolve the skills source directory using conventional paths with env override. */
function resolveSkillsDir(): string | null {
  // 1. Explicit override
  const envDir = process.env.RELEASED_SKILLS_DIR;
  if (envDir && existsSync(envDir)) return envDir;

  // 2. Container convention
  const containerDir = "/usr/share/releases/skills";
  if (existsSync(containerDir)) return containerDir;

  // 3. Local user convention
  const localDir = resolve(homedir(), ".releases/skills");
  if (existsSync(localDir)) return localDir;

  // 4. Dev fallback — source tree (for running via bun src/index.ts)
  const devDir = resolve(import.meta.dir, "skills");
  if (existsSync(devDir)) return devDir;

  return null;
}

/** Ensure agent skills are discoverable at .claude/skills/ in cwd. */
function ensureSkillsDiscoverable(): void {
  const cwd = process.cwd();
  const skillsTarget = resolve(cwd, ".claude/skills");
  if (existsSync(skillsTarget)) return;

  const skillsSource = resolveSkillsDir();
  if (!skillsSource) {
    logger.warn("No agent skills directory found — agent will run without skills");
    return;
  }

  mkdirSync(resolve(cwd, ".claude"), { recursive: true });
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
      command: process.env.RELEASED_MCP_BROWSER_CMD ?? "releases-mcp-browser",
      args: [],
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
      cwd: process.cwd(),
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
            "Runs Released CLI commands or fetches web pages and reports results. Use for parallel validation, dry-run fetches, content sampling, or any task that doesn't need parent-level judgment.",
          prompt: `Run the given Released CLI command or web fetch task, evaluate the output, and report back with a structured summary including: command run, exit code, key findings (release count, errors, quality assessment).`,
          tools: ["Bash", "Read", "WebFetch"],
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

/** Status event emitted during discovery for StatusHub integration. */
export interface DiscoveryStatusEvent {
  type: "session:start" | "session:progress" | "session:complete" | "session:error";
  sessionId: string;
  company: string;
  [key: string]: unknown;
}

export interface DiscoveryOptions {
  company: string;
  domain?: string;
  githubOrg?: string;
  onProgress?: (text: string) => void;
  onToolUse?: (toolName: string, command?: string) => void;
  /** Emitted for StatusHub integration — maps agent events to session lifecycle. */
  onStatusEvent?: (event: DiscoveryStatusEvent) => void;
}

/** Build the user-facing discovery prompt with optional domain/org hints. */
export function buildDiscoveryPrompt(options: Pick<DiscoveryOptions, "company" | "domain" | "githubOrg">): string {
  const hints: string[] = [];
  if (options.domain) hints.push(`Their website is ${options.domain}.`);
  if (options.githubOrg) hints.push(`Their GitHub organization is ${options.githubOrg}.`);
  const hintStr = hints.length > 0 ? " " + hints.join(" ") : "";
  return `Find and evaluate changelog sources for "${options.company}".${hintStr} Check what we already have, discover new sources, validate them with dry-run fetches, then do a real fetch (--max 50) for each validated source to seed initial releases. For feed sources, note in the state file whether content appears sparse (short summaries) so enrichment can be run after fetching.`;
}

export async function runDiscovery(options: DiscoveryOptions): Promise<DiscoveryState> {
  const prompt = buildDiscoveryPrompt(options);

  return runAgent({
    prompt,
    domain: options.domain,
    githubOrg: options.githubOrg,
    onProgress: options.onProgress,
    onToolUse: options.onToolUse,
  });
}
