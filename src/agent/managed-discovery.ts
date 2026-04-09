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
import { buildDiscoverySystemPrompt } from "../shared/discovery-prompt.js";
import { parseArgs } from "../shared/parse-args.js";

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
  return buildDiscoverySystemPrompt({
    evaluateAvailable: true,
    categories: CATEGORIES,
  });
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
    const argv = parseArgs(command);
    const cliParts = parseArgs(cliCmd);
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

// ── Agent tools (shared between create and DO) ──────────────────

const DISCOVERY_TOOLS = [
  { type: "agent_toolset_20260401", default_config: { enabled: true } },
  {
    type: "custom",
    name: "releases_cli",
    description:
      "Execute a Released CLI command. Manages changelog sources, orgs, products. Use --json for structured output. Use --dry-run for validation, then real fetch (--max 50) to persist validated sources.",
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
];

// ── Agent/Environment setup ───────────────────────────────────────

async function ensureAgentAndEnv(
  client: Anthropic,
): Promise<{ agentId: string; agentVersion?: number; environmentId: string }> {
  // Prefer explicit env var IDs (agent + environment created once via console/API)
  const envAgentId = process.env.ANTHROPIC_AGENT_ID;
  const envEnvId = process.env.ANTHROPIC_ENVIRONMENT_ID;
  if (envAgentId && envEnvId) {
    const agentVersion = process.env.ANTHROPIC_AGENT_VERSION ? parseInt(process.env.ANTHROPIC_AGENT_VERSION, 10) : undefined;
    logger.debug(`[managed-agents] Using env var agent=${envAgentId} env=${envEnvId}`);
    return { agentId: envAgentId, agentVersion, environmentId: envEnvId };
  }

  // Fallback: auto-create for local development
  const currentPrompt = buildSystemPrompt();
  const currentHash = hashPrompt(currentPrompt);
  const cached = loadCachedConfig();

  if (cached && cached.promptHash === currentHash) {
    logger.debug(`[managed-agents] Using cached agent=${cached.agentId} env=${cached.environmentId}`);
    return cached;
  }

  let environmentId: string;

  if (cached) {
    logger.info("[managed-agents] System prompt changed — updating agent...");
    environmentId = cached.environmentId;

    const updated = await (client.beta.agents as any).update(cached.agentId, {
      version: cached.agentVersion,
      system: currentPrompt,
      model: config.agentModel(),
    });

    const cfg: ManagedAgentConfig = {
      agentId: updated.id,
      agentVersion: updated.version as number,
      environmentId,
      updatedAt: new Date().toISOString(),
      promptHash: currentHash,
    };
    saveCachedConfig(cfg);
    logger.info(`[managed-agents] Agent ${updated.id} updated to v${updated.version}`);
    return cfg;
  }

  logger.info("[managed-agents] Creating agent and environment (first run)...");
  const environment = await (client.beta.environments as any).create({
    name: "released-discovery",
    config: {
      type: "cloud",
      networking: { type: "unrestricted" },
    },
  });
  environmentId = environment.id;

  const agent = await (client.beta.agents as any).create({
    name: "Released Discovery Agent",
    model: config.agentModel(),
    system: currentPrompt,
    tools: DISCOVERY_TOOLS,
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
    agent: { type: "agent", id: agentId, ...(agentVersion ? { version: agentVersion } : {}) },
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
