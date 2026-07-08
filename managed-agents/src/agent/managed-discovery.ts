/**
 * Discovery via Anthropic Managed Agents.
 *
 * Alternative to the Claude Agent SDK path in discovery.ts.
 * CLI operations execute host-side via custom tools — secrets never enter
 * the Managed Agent container.
 */

import Anthropic from "@anthropic-ai/sdk";
import { buildAnthropicClient } from "@releases/lib/anthropic-client";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { config, getDataDir } from "@releases/lib/config";
import { sha256Hex } from "@releases/core-internal/hash";
import { logger } from "@buildinternet/releases-lib/logger";
import { CATEGORIES } from "@buildinternet/releases-core/categories";
import { buildDiscoveryPrompt } from "./discovery.js";
import type { DiscoveryState, DiscoveryOptions, DiscoveryStatusEvent } from "./discovery.js";
import { buildDiscoverySystemPrompt } from "../shared/discovery-prompt.js";
import {
  AGENT_TOOLS,
  buildMcpServerDefinition,
  buildMcpToolset,
  createTypedExecutor,
  handleCustomToolUse,
} from "../shared/agent-tools.js";
import { buildMemoryStoreResources } from "../shared/memory-store-attach.js";

// ── Cached IDs ────────────────────────────────────────────────────

interface ManagedAgentConfig {
  agentId: string;
  agentVersion: number;
  environmentId: string;
  vaultId?: string;
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

// ── Tool executor type ───────────────────────────────────────────

/** Executes a typed tool call and returns the output. */
export type ToolExecutor = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<string | null>;

// ── Agent/Environment setup ───────────────────────────────────────

async function ensureAgentAndEnv(
  client: Anthropic,
): Promise<{ agentId: string; agentVersion?: number; environmentId: string }> {
  // Prefer explicit env var IDs (agent + environment created once via console/API)
  const envAgentId = process.env.ANTHROPIC_AGENT_ID;
  const envEnvId = process.env.ANTHROPIC_ENVIRONMENT_ID;
  if (envAgentId && envEnvId) {
    const agentVersion = process.env.ANTHROPIC_AGENT_VERSION
      ? parseInt(process.env.ANTHROPIC_AGENT_VERSION, 10)
      : undefined;
    logger.debug(`[managed-agents] Using env var agent=${envAgentId} env=${envEnvId}`);
    return { agentId: envAgentId, agentVersion, environmentId: envEnvId };
  }

  // Fallback: auto-create for local development
  const currentPrompt = buildSystemPrompt();
  const currentHash = hashPrompt(currentPrompt);
  const cached = loadCachedConfig();

  if (cached && cached.promptHash === currentHash) {
    logger.debug(
      `[managed-agents] Using cached agent=${cached.agentId} env=${cached.environmentId}`,
    );
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
      tools: [...AGENT_TOOLS, buildMcpToolset()],
      mcp_servers: [buildMcpServerDefinition("production")],
    });

    const cfg: ManagedAgentConfig = {
      agentId: updated.id,
      agentVersion: updated.version as number,
      environmentId,
      vaultId: cached.vaultId,
      updatedAt: new Date().toISOString(),
      promptHash: currentHash,
    };
    saveCachedConfig(cfg);
    logger.info(`[managed-agents] Agent ${updated.id} updated to v${updated.version}`);
    return cfg;
  }

  logger.info("[managed-agents] Creating agent and environment (first run)...");
  const environment = await (client.beta.environments as any).create({
    name: "releases-discovery",
    config: {
      type: "cloud",
      networking: { type: "unrestricted" },
    },
  });
  environmentId = environment.id;

  const agent = await (client.beta.agents as any).create({
    name: "Releases Discovery Agent",
    model: config.agentModel(),
    system: currentPrompt,
    tools: [...AGENT_TOOLS, buildMcpToolset()],
    mcp_servers: [buildMcpServerDefinition("production")],
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

// ── Vault setup ──────────────────────────────────────────────────

const MCP_SERVER_URL = "https://mcp.releases.sh/mcp";

async function ensureVault(client: Anthropic): Promise<string> {
  // Prefer explicit env var
  const envVaultId = process.env.ANTHROPIC_VAULT_ID;
  if (envVaultId) {
    logger.debug(`[managed-agents] Using env var vault=${envVaultId}`);
    return envVaultId;
  }

  // Check cached config
  const cached = loadCachedConfig();
  if (cached?.vaultId) {
    logger.debug(`[managed-agents] Using cached vault=${cached.vaultId}`);
    return cached.vaultId;
  }

  // Auto-create vault + credential for local development
  logger.info("[managed-agents] Creating vault and MCP credential (first run)...");

  const vault = await (client.beta.vaults as any).create({
    display_name: "releases-system",
    metadata: { purpose: "releases-discovery-agent" },
  });

  await (client.beta.vaults.credentials as any).create(vault.id, {
    display_name: "Releases MCP Server",
    auth: {
      type: "static_bearer",
      mcp_server_url: MCP_SERVER_URL,
      token: "public-access",
    },
  });

  // Persist vault ID — re-read config in case ensureAgentAndEnv wrote it
  const current = loadCachedConfig();
  if (current) {
    current.vaultId = vault.id;
    saveCachedConfig(current);
  }

  logger.info(`[managed-agents] Vault ${vault.id} created with MCP credential`);
  return vault.id;
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
  executor?: ToolExecutor,
): Promise<DiscoveryState> {
  const apiKey = config.anthropicApiKey();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for managed agents discovery");
  }

  // Build typed executor if not provided — requires remote API
  const executeToolCall =
    executor ??
    (() => {
      const apiUrl = config.apiUrl();
      const releasesApiKey = config.apiKey();
      if (!apiUrl || !releasesApiKey) {
        throw new Error(
          "RELEASES_API_URL and RELEASES_API_KEY are required for managed agents discovery",
        );
      }
      return createTypedExecutor({
        fetcher: { fetch: globalThis.fetch.bind(globalThis) },
        apiKey: releasesApiKey,
        baseUrl: apiUrl.replace(/\/+$/, ""),
      });
    })();

  // Mirror the worker fix in workers/discovery/src/managed-agents-session.ts:
  // explicit baseURL bypasses ANTHROPIC_BASE_URL env (which the SDK auto-reads
  // and which can point at AI Gateway). The gateway buffers SSE-over-GET, so
  // any session that uses events.stream() would deadlock if routed through it.
  // See #547 and docs/architecture/ai-gateway.md.
  const client = buildAnthropicClient({ apiKey, baseURL: "https://api.anthropic.com" });
  // Sequential: ensureAgentAndEnv writes the config file that ensureVault reads
  const { agentId, agentVersion, environmentId } = await ensureAgentAndEnv(client);
  const vaultId = await ensureVault(client);

  const prompt = buildDiscoveryPrompt(options);

  const memoryResources = buildMemoryStoreResources({
    mode: "onboard",
    errataStoreId: process.env.MEMORY_STORE_ERRATA_ID,
    toolNotesStoreId: process.env.MEMORY_STORE_TOOL_NOTES_ID,
  });

  // Create session with vault for MCP server access
  const session = await client.beta.sessions.create({
    agent: { type: "agent", id: agentId, ...(agentVersion ? { version: agentVersion } : {}) },
    environment_id: environmentId,
    vault_ids: [vaultId],
    ...(memoryResources.length > 0 ? { resources: memoryResources } : {}),
    title: `Discovery: ${options.company}`,
  } as any);

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
  // Using a mutable container so TS tracks closure mutations correctly
  const captured: { state: DiscoveryState | null } = { state: null };
  let toolCallCount = 0;
  let done = false;
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  const timeoutTimer = setTimeout(() => {
    logger.warn("[managed-agents] Session timeout — aborting stream");
    try {
      stream.controller.abort();
    } catch {
      /* already closed */
    }
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
          const sendResult = async (toolUseId: string, text: string) => {
            await client.beta.sessions.events.send(session.id, {
              events: [
                {
                  type: "user.custom_tool_result",
                  custom_tool_use_id: toolUseId,
                  content: [{ type: "text", text }],
                },
              ],
            });
          };
          const wasStateReport = await handleCustomToolUse(
            { id: toolEvent.id, name: toolEvent.name, input: toolEvent.input },
            {
              sendResult,
              executor: executeToolCall,
              getRemainingSessionMs: () => Math.max(0, deadline - Date.now()),
              sessionId: session.id,
              agentName: "discovery",
              onStateCapture: (state) => {
                captured.state = state as unknown as DiscoveryState;
              },
              onToolCall: (toolName, toolInput) => {
                options.onToolUse?.(toolName, JSON.stringify(toolInput));
                toolCallCount++;
                emitStatus(options, session.id, {
                  type: "session:progress",
                  step: "discovery",
                  currentAction: toolName,
                  toolCalls: toolCallCount,
                });
              },
            },
          );
          if (wasStateReport) continue;
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
    try {
      stream.controller.abort();
    } catch {
      /* already closed */
    }
    // Archive in the finally so timeout-abort paths leave the Anthropic
    // session in a clean state — without this, a stalled tool call locks
    // subsequent retries with a 400 ("waiting on responses to events …").
    // See #632. Mirrored by workers/discovery/src/managed-agents-session.ts.
    try {
      await client.beta.sessions.archive(session.id);
    } catch {
      /* non-critical */
    }
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

  if (captured.state) {
    captured.state.agentSessionId = session.id;
    emitStatus(options, session.id, {
      type: "session:complete",
      sourcesFound: captured.state.sources?.length ?? 0,
      sourcesValidated: captured.state.sources?.filter((s) => s.validated).length ?? 0,
    });
    return captured.state;
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
