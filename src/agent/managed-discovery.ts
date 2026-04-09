/**
 * Discovery via Anthropic Managed Agents.
 *
 * Alternative to the Claude Agent SDK path in released.ts.
 * CLI operations execute host-side via custom tools — secrets never enter
 * the Managed Agent container.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { $ } from "bun";
import { config, getDataDir, resolveCLICmd } from "../lib/config.js";
import { sha256Hex } from "../lib/hash.js";
import { logger } from "../lib/logger.js";
import { CATEGORIES } from "../lib/categories.js";
import { buildDiscoveryPrompt } from "./released.js";
import type { DiscoveryState, DiscoveryOptions, DiscoveryStatusEvent } from "./released.js";

// ── Cached IDs ────────────────────────────────────────────────────

interface ManagedAgentConfig {
  agentId: string;
  agentVersion: number;
  environmentId: string;
  updatedAt: string;
  promptHash?: string;
}

const CONFIG_PATH = resolve(getDataDir(), "managed-agents.json");

function loadCachedConfig(): ManagedAgentConfig | null {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as ManagedAgentConfig;
  } catch {
    return null;
  }
}

function saveCachedConfig(cfg: ManagedAgentConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ── System prompt ─────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You manage changelog sources for Released. You find, evaluate, add, fetch, and validate changelog sources using the releases_cli tool.

## CLI Commands Reference

Call the releases_cli tool with the command string (without the "releases" prefix):

- list [slug] [--json] [--org <org>] [--has-feed] [--enrichable] [--product <p>] [--category <c>] [--query <text>]
- evaluate <url> [--json]: Evaluate a URL for the best ingestion method
- discover <domain> [--json]: Probe a domain for changelog URLs, feeds, and GitHub repos
- add <name> --url <url> [--type <type>] [--org <org>] [--feed-url <url>] [--skip-eval]
- fetch <slug> [--dry-run] [--max <n>] [--full] [--crawl] [--no-crawl]: Fetch releases
- fetch-log <slug>: Show recent fetch history
- remove <slug> [--ignore --reason <reason>]: Remove a source
- enrich <slug> [--dry-run] [--limit <n>] [--force]: Enrich sparse releases
- org add <name> [--domain <d>] [--description <t>] [--category <c>] [--tags <t1,t2>]
- org edit <slug> [--category <c>]
- org show <slug>: Full org details with accounts, tags, sources, products
- org tag add <slug> <tag1> [tag2...]
- product add <name> --org <org> [--category <c>] [--tags <t1,t2>] [--url <u>] [--description <t>]
- product edit <slug> [--category <c>]
- product tag add <slug> <tag1> [tag2...]
- ignore list --org <org> --json / ignore add --org <org> <url>
- block list --json / block add <url>
- categories [--json]: List valid categories
- edit <slug> [--primary] [--no-primary] [--priority <p>] [--metadata <json>]

## Available Categories

Valid categories: ${CATEGORIES.join(", ")}

When creating an organization, always include a --description with a brief one-sentence product description.

## Multi-Product Organizations

Some organizations ship multiple distinct products. When you discover sources that clearly belong to different products:
- High confidence (separate repos, separate domains): Create products using product add
- Medium confidence: Note suggested groupings but don't auto-create
- Low confidence: Leave sources at the org level

## Onboarding Workflow

1. **Discover** — find changelog URLs, feeds, and GitHub repos
2. **Add** — add sources with appropriate types
3. **Validate** — dry-run fetch each source to check quality
4. **Assess content depth** — for feed sources, check if pages have richer content than feeds
5. **Report** — summarize what was found

Do NOT actually fetch (without --dry-run) unless explicitly told to.

## Source Selection

Prefer 3-5 high-signal sources per org over exhaustive coverage. Only index the org's own products, not ecosystem plugins. Add and pause low-value sources rather than omitting them entirely.

## Output

Keep output concise — focus on actions and results.

IMPORTANT: At the end of discovery, call the releases_report_state tool with the complete discovery state JSON object (do NOT write to a file). The state object must include: product, domain, githubOrg, startedAt, updatedAt, status, and sources array. Use this schema:
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
      "slug": "<slug from releases add>",
      "label": "<human-readable label>",
      "confidence": "high|medium|low",
      "validated": true/false,
      "validationError": "<error message if validation failed>",
      "releaseCount": <number>,
      "contentDepth": "full|summary-only"
    }
  ]
}`;
}

function hashPrompt(prompt: string): string {
  return sha256Hex(prompt).slice(0, 16);
}

// ── CLI execution ─────────────────────────────────────────────────

/** Executes a CLI command string and returns the output. Injectable for worker context. */
export type CLIExecutor = (command: string) => Promise<string>;

/** Default executor — spawns the CLI as a subprocess (Bun shell). */
export function createSubprocessExecutor(): CLIExecutor {
  const cliCmd = resolveCLICmd();
  return async (command: string): Promise<string> => {
    const argv = command.trim().split(/\s+/);
    const cliParts = cliCmd.trim().split(/\s+/);
    const fullArgs = [...cliParts, ...argv];
    logger.debug(`[managed-agents] $ ${fullArgs.join(" ")}`);

    try {
      const result = await $`${fullArgs}`.quiet().nothrow();
      const stdout = result.stdout.toString().trim();
      const stderr = result.stderr.toString().trim();

      if (result.exitCode !== 0) {
        return `Command failed (exit ${result.exitCode}):\n${stderr || stdout}`;
      }
      return stdout || "(no output)";
    } catch (err) {
      return `Command error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}

// ── Agent/Environment setup ───────────────────────────────────────

async function ensureAgentAndEnv(
  client: Anthropic,
): Promise<{ agentId: string; agentVersion: number; environmentId: string }> {
  const currentPrompt = buildSystemPrompt();
  const currentHash = hashPrompt(currentPrompt);
  const cached = loadCachedConfig();

  if (cached && cached.promptHash === currentHash) {
    logger.debug(`[managed-agents] Using cached agent=${cached.agentId} env=${cached.environmentId}`);
    return cached;
  }

  // Reuse existing environment if available (config is invariant)
  let environmentId: string;

  if (cached) {
    logger.info("[managed-agents] System prompt changed — recreating agent...");
    environmentId = cached.environmentId;
    // Archive old agent (non-critical)
    try { await client.beta.agents.archive(cached.agentId); } catch { /* non-critical */ }
  } else {
    logger.info("[managed-agents] Creating agent and environment (first run)...");
    const environment = await (client.beta.environments as any).create({
      name: `released-discovery-${Date.now()}`,
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
      },
    });
    environmentId = environment.id;
  }

  const agent = await (client.beta.agents as any).create({
    name: "Released Discovery Agent",
    model: config.agentModel(),
    system: currentPrompt,
    tools: [
      { type: "agent_toolset_20260401", default_config: { enabled: true } },
      {
        type: "custom",
        name: "releases_cli",
        description:
          "Execute a Released CLI command. Manages changelog sources, orgs, products. Use --json for structured output. Do NOT fetch without --dry-run unless told to persist.",
        input_schema: {
          type: "object" as const,
          properties: {
            command: {
              type: "string",
              description:
                'CLI command and arguments without the "releases" prefix. Example: "list --json" or "fetch my-source --dry-run"',
            },
          },
          required: ["command"],
        },
      },
      {
        type: "custom",
        name: "releases_report_state",
        description:
          "Report the final discovery state as JSON. Call this at the end of discovery instead of writing to a file.",
        input_schema: {
          type: "object" as const,
          properties: {
            state: {
              type: "object",
              description: "The complete discovery state JSON object with product, domain, sources, etc.",
            },
          },
          required: ["state"],
        },
      },
    ],
  });

  const cfg: ManagedAgentConfig = {
    agentId: agent.id,
    agentVersion: agent.version as number,
    environmentId,
    updatedAt: new Date().toISOString(),
    promptHash: currentHash,
  };

  saveCachedConfig(cfg);
  logger.info(`[managed-agents] Agent ${agent.id} env=${environmentId} created and cached`);

  return cfg;
}

// ── Constants ────────────────────────────────────────────────────

const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15-minute wall-clock deadline

function emitStatus(
  options: DiscoveryOptions,
  sessionId: string,
  partial: { type: DiscoveryStatusEvent["type"]; [key: string]: unknown },
): void {
  options.onStatusEvent?.({
    ...partial,
    sessionId,
    company: options.company,
  } as DiscoveryStatusEvent);
}

// ── Run discovery ─────────────────────────────────────────────────

export async function runManagedDiscovery(
  options: DiscoveryOptions,
  executor?: CLIExecutor,
): Promise<DiscoveryState> {
  const executeCLI = executor ?? createSubprocessExecutor();
  const apiKey = config.anthropicApiKey();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for managed agents discovery");
  }

  const client = new Anthropic({ apiKey });
  const { agentId, agentVersion, environmentId } = await ensureAgentAndEnv(client);

  const prompt = buildDiscoveryPrompt(options);

  // Create session
  const session = await client.beta.sessions.create({
    agent: { type: "agent", id: agentId, version: agentVersion },
    environment_id: environmentId,
    title: `Discovery: ${options.company}`,
  });

  logger.info(`[managed-agents] Session ${session.id} created`);

  emitStatus(options, session.id, { type: "session:start" });

  // Stream-first: open stream, then send message
  const stream = await client.beta.sessions.events.stream(session.id);

  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: prompt }],
      },
    ],
  });

  // Process events with wall-clock timeout
  let capturedState: DiscoveryState | null = null;
  let toolCallCount = 0;
  let done = false;
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  const timeoutTimer = setTimeout(() => {
    logger.warn("[managed-agents] Session timeout — aborting stream");
    try { stream.controller.abort(); } catch { /* already closed */ }
  }, SESSION_TIMEOUT_MS);

  try {
    for await (const event of stream) {
      if (Date.now() > deadline) {
        logger.warn("[managed-agents] Session exceeded timeout, breaking event loop");
        break;
      }
      switch (event.type) {
        case "agent.message":
          for (const block of (event as any).content ?? []) {
            if (block.type === "text") {
              options.onProgress?.(block.text);
            }
          }
          break;

        case "agent.tool_use":
          options.onToolUse?.((event as any).name, undefined);
          break;

        case "agent.custom_tool_use": {
          const toolEvent = event as any;

          if (toolEvent.name === "releases_report_state") {
            const reported = toolEvent.input?.state;
            if (reported && typeof reported === "object") {
              capturedState = reported as DiscoveryState;
              capturedState.updatedAt = new Date().toISOString();
            } else {
              logger.warn("[managed-agents] releases_report_state called with missing/invalid state");
            }
            await client.beta.sessions.events.send(session.id, {
              events: [{
                type: "user.custom_tool_result",
                custom_tool_use_id: toolEvent.id,
                content: [{ type: "text", text: "State captured successfully." }],
              }],
            });
            continue; // Don't break — let the agent finish naturally
          }

          if (toolEvent.name !== "releases_cli") {
            // Unknown custom tool — no-op, send empty result
            await client.beta.sessions.events.send(session.id, {
              events: [{
                type: "user.custom_tool_result",
                custom_tool_use_id: toolEvent.id,
                content: [{ type: "text", text: "Unknown tool" }],
              }],
            });
            break;
          }

          const input = toolEvent.input as { command?: string };
          const command = input?.command ?? "";

          options.onToolUse?.("releases_cli", command);
          toolCallCount++;

          emitStatus(options, session.id, {
            type: "session:progress",
            step: "discovery",
            currentAction: `releases ${command}`,
            toolCalls: toolCallCount,
          });

          const result = await executeCLI(command);

          // Truncate very large outputs
          const maxLen = 50_000;
          const truncated =
            result.length > maxLen
              ? result.slice(0, maxLen) + `\n\n[output truncated — ${result.length} total chars]`
              : result;

          await client.beta.sessions.events.send(session.id, {
            events: [
              {
                type: "user.custom_tool_result",
                custom_tool_use_id: toolEvent.id,
                content: [{ type: "text", text: truncated }],
              },
            ],
          });
          break;
        }

        case "session.status_idle": {
          if ((event as any).stop_reason?.type === "requires_action") continue;
          done = true;
          break;
        }

        case "session.status_terminated":
          done = true;
          break;

        case "session.error":
          logger.error(`[managed-agents] Session error: ${JSON.stringify(event)}`);
          emitStatus(options, session.id, {
            type: "session:error",
            error: (event as any).error ?? "Unknown session error",
          });
          break;
      }

      if (done) break;
    }
  } finally {
    clearTimeout(timeoutTimer);
    // Ensure stream is cleaned up
    try { stream.controller.abort(); } catch { /* already closed */ }
  }

  // Fetch usage for logging
  try {
    const finalSession = await client.beta.sessions.retrieve(session.id);
    const usage = finalSession.usage as Record<string, unknown> | undefined;
    if (usage) {
      logger.info(`[managed-agents] Session usage: ${JSON.stringify(usage)}`);
    }
  } catch {
    // Non-critical
  }

  // Archive session (non-critical — session will expire naturally if this fails)
  try {
    await client.beta.sessions.archive(session.id);
  } catch {
    // Non-critical
  }

  if (capturedState) {
    capturedState.agentSessionId = session.id;
    emitStatus(options, session.id, {
      type: "session:complete",
      sourcesFound: capturedState.sources?.length ?? 0,
      sourcesValidated: capturedState.sources?.filter((s) => s.validated).length ?? 0,
    });
    return capturedState;
  }

  // Fallback minimal state — no captured state means something went wrong
  emitStatus(options, session.id, {
    type: "session:error",
    error: "Agent did not report discovery state",
  });

  const now = new Date().toISOString();
  return {
    product: options.company,
    domain: options.domain,
    githubOrg: options.githubOrg,
    startedAt: now,
    updatedAt: now,
    status: "awaiting_review",
    sources: [],
    agentSessionId: session.id,
  };
}
