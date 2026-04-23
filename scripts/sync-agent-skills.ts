#!/usr/bin/env bun
/**
 * Deploy managed agents: sync skills, system prompt, tools, and model.
 *
 * Manages two agents per environment:
 *   - Discovery agent (Sonnet) — onboarding, evaluation, judgment tasks
 *   - Worker agent (Haiku) — fetches, updates, mechanical operations
 *
 * Usage:
 *   bun scripts/sync-agent-skills.ts                  # deploy skills, agents, memory stores (prod)
 *   bun scripts/sync-agent-skills.ts --env staging    # deploy against staging agents
 *   bun scripts/sync-agent-skills.ts --dry-run        # preview without changes
 *   bun scripts/sync-agent-skills.ts --skills         # skills only
 *   bun scripts/sync-agent-skills.ts --agent          # prompt/tools/model only
 *   bun scripts/sync-agent-skills.ts --memory-stores  # memory stores only
 *   bun scripts/sync-agent-skills.ts --discovery      # discovery agent only
 *   bun scripts/sync-agent-skills.ts --worker         # worker agent only
 *   bun scripts/sync-agent-skills.ts --agent-id <id>  # target an ad-hoc agent
 *
 * `--agent-id <id>` overrides the discovery/worker targets and syncs a single
 * arbitrary agent instead. Pushes skill resource versions (which propagate to
 * any agent via `version: "latest"`), attaches the skill IDs, and updates
 * tools when AGENT_TOOLS has changed. Never touches the target's system
 * prompt or model — intended for ad-hoc / eval agents whose prompts are
 * hand-maintained outside the discovery/worker prompt builders.
 *
 * Requires ANTHROPIC_API_KEY in .env or environment.
 *
 * Per-env state lives in scripts/agent-skills.json (prod) and
 * scripts/agent-skills.staging.json. Staging skills are created as separate
 * Anthropic custom-skill resources with the display title suffixed
 * " (staging)" so iteration in staging does not affect prod agents.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import { buildDiscoverySystemPrompt } from "../src/shared/discovery-prompt.js";
import { buildWorkerSystemPrompt } from "../src/shared/worker-prompt.js";
import { AGENT_TOOLS } from "../src/shared/agent-tools.js";
import { CATEGORIES } from "@buildinternet/releases-core/categories";

// ── Config ───────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SKILLS_DIR = resolve(PROJECT_ROOT, "src/agent/skills");

type DeployEnv = "production" | "staging";

function configPathFor(env: DeployEnv): string {
  return env === "staging"
    ? resolve(PROJECT_ROOT, "scripts/agent-skills.staging.json")
    : resolve(PROJECT_ROOT, "scripts/agent-skills.json");
}

function displayTitleSuffixFor(env: DeployEnv): string {
  return env === "staging" ? " (staging)" : "";
}

const SKILL_DIRS = [
  "finding-changelogs",
  "managing-sources",
  "parsing-changelogs",
  "analyzing-releases",
  "classify-media-relevance",
];

/**
 * Managed-agents memory stores created idempotently per environment.
 * Store IDs are recorded in the config file under `memoryStores.<key>`
 * and surfaced to workers via env vars in their wrangler.jsonc.
 */
function memoryStoreEnvVarFor(key: string): string {
  return key === "errata" ? "MEMORY_STORE_ERRATA_ID" : "MEMORY_STORE_TOOL_NOTES_ID";
}

const MEMORY_STORES = [
  {
    key: "errata",
    name: "releases-errata",
    description:
      "Per-organization corrections and observations layered over playbook notes. " +
      "Paths: /orgs/<org_id>/errata.md (trusted rules), " +
      "/orgs/<org_id>/observations.md (unvalidated priors), " +
      "/discovery/global.md (discovery-scope notes, written before an org is resolved).",
  },
  {
    key: "toolNotes",
    name: "releases-tool-notes",
    description:
      "Global harness and MCP tool quirks learned in session. " +
      "Paths: /tools/<tool>.md, /mcp/<server>/<tool>.md, /harness/notes.md. " +
      "Log tool errors and workarounds here — keep entries short, factual, cross-session.",
  },
] as const;

const ANTHROPIC_API = "https://api.anthropic.com";
const HEADERS = {
  "x-api-key": "",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "skills-2025-10-02",
};

const AGENT_HEADERS = {
  "x-api-key": "",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "managed-agents-2026-04-01",
  "content-type": "application/json",
};

// ── Types ────────────────────────────────────────────────────────

interface SkillMapping {
  [displayTitle: string]: {
    skillId: string;
    localDir: string;
  };
}

interface SkillConfig {
  skills: SkillMapping;
  agentId: string;
  promptHash?: string;
  toolsHash?: string;
  workerAgentId?: string;
  workerPromptHash?: string;
  memoryStores?: {
    errata?: string;
    toolNotes?: string;
  };
}

interface ApiSkill {
  id: string;
  display_title: string;
  source: string;
  latest_version: string;
}

// ── Helpers ──────────────────────────────────────────────────────

function loadConfig(configPath: string): SkillConfig | null {
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function saveConfig(configPath: string, cfg: SkillConfig): void {
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
}

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // Try loading from .env
    try {
      const envFile = readFileSync(resolve(PROJECT_ROOT, ".env"), "utf8");
      const match = envFile.match(/^ANTHROPIC_API_KEY=(.+)$/m);
      if (match) return match[1].trim();
    } catch {
      /* ignore */
    }
    throw new Error("ANTHROPIC_API_KEY not found in environment or .env");
  }
  return key;
}

function readWranglerVar(varName: string): string | null {
  try {
    const wrangler = readFileSync(
      resolve(PROJECT_ROOT, "workers/discovery/wrangler.jsonc"),
      "utf8",
    );
    const match = wrangler.match(new RegExp(`"${varName}":\\s*"([^"]+)"`));
    if (match) return match[1];
  } catch {
    /* ignore */
  }
  return null;
}

function getAgentId(env: DeployEnv, config: SkillConfig | null): string {
  // Staging reads exclusively from the staging config file (seeded with the IDs
  // created in the Anthropic console). Prod retains the historical lookup chain
  // for backwards compatibility with operators who set env vars or edit the
  // wrangler.jsonc by hand.
  if (env === "staging") {
    const id = config?.agentId ?? process.env.ANTHROPIC_AGENT_ID;
    if (!id) {
      throw new Error(
        "Staging ANTHROPIC_AGENT_ID not found. Seed scripts/agent-skills.staging.json or set ANTHROPIC_AGENT_ID.",
      );
    }
    return id;
  }
  const id = process.env.ANTHROPIC_AGENT_ID ?? readWranglerVar("ANTHROPIC_AGENT_ID");
  if (!id) {
    throw new Error(
      "ANTHROPIC_AGENT_ID not found. Set it in env or workers/discovery/wrangler.jsonc",
    );
  }
  return id;
}

function getWorkerAgentId(env: DeployEnv, config: SkillConfig | null): string | null {
  if (env === "staging") {
    return config?.workerAgentId ?? process.env.ANTHROPIC_WORKER_AGENT_ID ?? null;
  }
  return (
    process.env.ANTHROPIC_WORKER_AGENT_ID ??
    readWranglerVar("ANTHROPIC_WORKER_AGENT_ID") ??
    config?.workerAgentId ??
    null
  );
}

function displayTitleFromDir(dir: string): string {
  // "finding-changelogs" → "Finding Changelogs"
  return dir
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Read the SKILL.md content from a skill directory. */
function readSkillFile(dirName: string): { path: string; content: Buffer } {
  const skillPath = resolve(SKILLS_DIR, dirName, "SKILL.md");
  if (!existsSync(skillPath)) {
    throw new Error(`SKILL.md not found at ${skillPath}`);
  }
  return { path: skillPath, content: readFileSync(skillPath) };
}

// ── API calls ────────────────────────────────────────────────────

async function listCustomSkills(apiKey: string): Promise<ApiSkill[]> {
  const res = await fetch(`${ANTHROPIC_API}/v1/skills?source=custom`, {
    headers: { ...HEADERS, "x-api-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`Failed to list skills: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: ApiSkill[] };
  return body.data;
}

async function createSkill(
  apiKey: string,
  displayTitle: string,
  skillFile: Buffer,
  dirName: string,
): Promise<ApiSkill> {
  const form = new FormData();
  form.append("display_title", displayTitle);
  form.append("files[]", new Blob([skillFile]), `${dirName}/SKILL.md`);

  const res = await fetch(`${ANTHROPIC_API}/v1/skills`, {
    method: "POST",
    headers: { ...HEADERS, "x-api-key": apiKey },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Failed to create skill "${displayTitle}": ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ApiSkill;
}

async function createSkillVersion(
  apiKey: string,
  skillId: string,
  skillFile: Buffer,
  dirName: string,
): Promise<{ version: string }> {
  const form = new FormData();
  form.append("files[]", new Blob([skillFile]), `${dirName}/SKILL.md`);

  const res = await fetch(`${ANTHROPIC_API}/v1/skills/${skillId}/versions`, {
    method: "POST",
    headers: { ...HEADERS, "x-api-key": apiKey },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Failed to create version for ${skillId}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { version: string };
}

async function getAgent(
  apiKey: string,
  agentId: string,
): Promise<{
  version: number;
  skills: unknown[];
  system: string;
  tools: unknown[];
  model: { id: string; speed?: string };
}> {
  const res = await fetch(`${ANTHROPIC_API}/v1/agents/${agentId}`, {
    headers: { ...AGENT_HEADERS, "x-api-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`Failed to get agent ${agentId}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as {
    version: number;
    skills: unknown[];
    system: string;
    tools: unknown[];
    model: { id: string; speed?: string };
  };
}

async function createAgent(
  apiKey: string,
  payload: {
    name: string;
    model: string;
    system: string;
    tools: unknown[];
    skills?: { type: string; skill_id: string; version: string }[];
  },
): Promise<{ id: string; version: number }> {
  const res = await fetch(`${ANTHROPIC_API}/v1/agents`, {
    method: "POST",
    headers: { ...AGENT_HEADERS, "x-api-key": apiKey },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Failed to create agent: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { id: string; version: number };
}

async function updateAgent(
  apiKey: string,
  agentId: string,
  agentVersion: number,
  payload: {
    skills?: { type: string; skill_id: string; version: string }[];
    system?: string;
    tools?: unknown[];
    model?: string;
  },
): Promise<{ version: number }> {
  const res = await fetch(`${ANTHROPIC_API}/v1/agents/${agentId}`, {
    method: "POST",
    headers: { ...AGENT_HEADERS, "x-api-key": apiKey },
    body: JSON.stringify({
      version: agentVersion,
      ...payload,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to update agent: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { version: number };
}

// ── Memory stores ───────────────────────────────────────────────

interface ApiMemoryStore {
  id: string;
  name: string;
  description: string | null;
  archived_at: string | null;
}

async function listMemoryStores(apiKey: string): Promise<ApiMemoryStore[]> {
  const res = await fetch(`${ANTHROPIC_API}/v1/memory_stores`, {
    headers: { ...AGENT_HEADERS, "x-api-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`Failed to list memory stores: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: ApiMemoryStore[] };
  return body.data;
}

async function createMemoryStore(
  apiKey: string,
  name: string,
  description: string,
): Promise<ApiMemoryStore> {
  const res = await fetch(`${ANTHROPIC_API}/v1/memory_stores`, {
    method: "POST",
    headers: { ...AGENT_HEADERS, "x-api-key": apiKey },
    body: JSON.stringify({ name, description }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create memory store "${name}": ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ApiMemoryStore;
}

// ── Hashing ─────────────────────────────────────────────────────

function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const skillsOnly = process.argv.includes("--skills");
  const agentOnly = process.argv.includes("--agent");
  const memoryStoresOnly = process.argv.includes("--memory-stores");
  const discoveryOnly = process.argv.includes("--discovery");
  const workerOnly = process.argv.includes("--worker");

  const agentIdIdx = process.argv.indexOf("--agent-id");
  const agentIdOverride = agentIdIdx >= 0 ? process.argv[agentIdIdx + 1] : null;
  if (agentIdIdx >= 0 && !agentIdOverride) {
    throw new Error("--agent-id requires a value");
  }

  // Any of --skills, --agent, --memory-stores narrows to that subsystem only.
  const anyOnly = skillsOnly || agentOnly || memoryStoresOnly;
  const syncSkills = !anyOnly || skillsOnly;
  const syncAgent = !anyOnly || agentOnly;
  const syncMemoryStores = !anyOnly || memoryStoresOnly;
  // --agent-id disables the default discovery/worker targets. Only the
  // override agent is touched.
  const syncDiscovery = !workerOnly && !agentIdOverride;
  const syncWorker = !discoveryOnly && !agentIdOverride;

  const envIdx = process.argv.indexOf("--env");
  const envArg = envIdx >= 0 ? process.argv[envIdx + 1] : "production";
  if (envArg !== "production" && envArg !== "staging") {
    throw new Error(`--env must be "production" or "staging"; got "${envArg}"`);
  }
  const deployEnv = envArg as DeployEnv;
  const configPath = configPathFor(deployEnv);
  const titleSuffix = displayTitleSuffixFor(deployEnv);

  const apiKey = getApiKey();
  const configOnDisk = loadConfig(configPath);
  // Skip the discovery-agent lookup when the caller is targeting an
  // override — the discovery config may not even be populated (e.g. running
  // --agent-id against a freshly seeded staging config).
  const agentId = agentIdOverride ?? getAgentId(deployEnv, configOnDisk);

  console.log(`Environment: ${deployEnv}`);
  if (agentIdOverride) console.log(`Target agent (override): ${agentIdOverride}`);
  else if (syncDiscovery) console.log(`Discovery agent: ${agentId}`);
  if (dryRun) console.log("DRY RUN — no changes will be made");
  console.log();

  const config = configOnDisk || {
    skills: {},
    agentId,
  };

  // Only fetch discovery agent state when we need it
  let agent: { version: number; model: { id: string } } | null = null;
  if (syncDiscovery && syncAgent) {
    agent = await getAgent(apiKey, agentId);
  }

  // ── 1. Sync skills ────────────────────────────────────────────
  let skillIds: { type: string; skill_id: string; version: string }[] = [];
  let skillsChanged = 0;

  if (syncSkills) {
    console.log(`Skills dir: ${SKILLS_DIR}`);

    const existing = await listCustomSkills(apiKey);
    const existingByTitle = new Map(existing.map((s) => [s.display_title, s]));
    console.log(`Found ${existing.length} existing custom skill(s)\n`);

    for (const dirName of SKILL_DIRS) {
      const baseTitle = displayTitleFromDir(dirName);
      const displayTitle = `${baseTitle}${titleSuffix}`;
      const { content } = readSkillFile(dirName);
      const remote = existingByTitle.get(displayTitle);
      // Cache key stays on the base title so the staging config file mirrors
      // the prod structure — only the Anthropic resource ID differs.
      const cached = config.skills[baseTitle];
      const existingId = remote?.id ?? cached?.skillId;

      if (existingId) {
        console.log(`↻ ${displayTitle} (${existingId}) — pushing new version`);
        skillsChanged++;
        if (!dryRun) {
          // oxlint-disable-next-line no-await-in-loop -- API rate limit; skills must be deployed sequentially
          const newVersion = await createSkillVersion(apiKey, existingId, content, dirName);
          config.skills[baseTitle] = {
            skillId: existingId,
            localDir: dirName,
          };
          console.log(`  ✓ Version ${newVersion.version}\n`);
        } else {
          console.log(`  (would create new version)\n`);
        }
        skillIds.push({ type: "custom", skill_id: existingId, version: "latest" });
      } else {
        console.log(`+ ${displayTitle} — creating new skill`);
        skillsChanged++;
        if (!dryRun) {
          // oxlint-disable-next-line no-await-in-loop -- API rate limit; skills must be deployed sequentially
          const created = await createSkill(apiKey, displayTitle, content, dirName);
          config.skills[baseTitle] = {
            skillId: created.id,
            localDir: dirName,
          };
          skillIds.push({ type: "custom", skill_id: created.id, version: "latest" });
          console.log(`  ✓ Created ${created.id}\n`);
        } else {
          console.log(`  (would create new skill — no cached ID)\n`);
        }
      }
    }

    if (!dryRun) saveConfig(configPath, config);
  }

  // ── 1b. Sync memory stores ───────────────────────────────────
  // Idempotent: looks up by display name (with env suffix), creates if
  // missing, records ID in config. Never updates name/description on
  // existing stores — edit those in the console if needed.

  if (syncMemoryStores) {
    console.log("── Memory Stores ────────────────────────────────");
    const remote = await listMemoryStores(apiKey);
    const byName = new Map(remote.map((s) => [s.name, s]));
    const storeIds: Record<string, string> = { ...config.memoryStores };

    for (const def of MEMORY_STORES) {
      const displayName = `${def.name}${titleSuffix}`;
      const existing = byName.get(displayName);
      const cached = config.memoryStores?.[def.key];
      const existingId = existing?.id ?? cached;

      if (existingId) {
        console.log(`✓ ${displayName} (${existingId}) — exists`);
        storeIds[def.key] = existingId;
      } else {
        console.log(`+ ${displayName} — creating`);
        if (!dryRun) {
          // oxlint-disable-next-line no-await-in-loop -- sequential for deterministic logging
          const created = await createMemoryStore(apiKey, displayName, def.description);
          storeIds[def.key] = created.id;
          console.log(`  ✓ Created ${created.id}`);
        } else {
          console.log(`  (would create memory store)`);
        }
      }
    }

    const missingInWrangler = Object.entries(storeIds).filter(([key, id]) => {
      const present = readWranglerVar(memoryStoreEnvVarFor(key));
      return id && present !== id;
    });
    if (missingInWrangler.length > 0) {
      console.log();
      console.log("  ℹ wrangler.jsonc vars to set for the discovery + api workers:");
      for (const [key, id] of missingInWrangler) {
        console.log(`    "${memoryStoreEnvVarFor(key)}": "${id}"`);
      }
    }

    if (!dryRun) {
      config.memoryStores = storeIds as SkillConfig["memoryStores"];
      saveConfig(configPath, config);
    }
    console.log();
  }

  // ── 2. Sync agents ─────────────────────────────────────────────

  const currentToolsHash = hash(JSON.stringify(AGENT_TOOLS));

  interface AgentSyncParams {
    label: string;
    agentId: string;
    prompt: string;
    promptHash: string;
    cachedPromptHash: string | undefined;
    model: string;
    remoteAgent: { version: number; model: { id: string } };
    onSuccess: () => void;
  }

  /** Diff an agent's prompt/tools/model/skills against remote and apply updates. */
  async function syncAgentConfig(params: AgentSyncParams): Promise<void> {
    const {
      label,
      agentId: id,
      prompt,
      promptHash,
      cachedPromptHash,
      model,
      remoteAgent,
      onSuccess,
    } = params;
    const payload: {
      skills?: typeof skillIds;
      system?: string;
      tools?: unknown[];
      model?: string;
    } = {};
    const changes: string[] = [];

    if (skillsChanged > 0) {
      payload.skills = skillIds;
      changes.push(`${skillsChanged} skill(s)`);
    }

    if (cachedPromptHash !== promptHash) {
      console.log(`  System prompt: changed (${cachedPromptHash ?? "none"} → ${promptHash})`);
      payload.system = prompt;
      changes.push("system prompt");
    } else {
      console.log(`  System prompt: up to date (${promptHash})`);
    }

    if (config.toolsHash !== currentToolsHash) {
      console.log(`  Tools: changed (${config.toolsHash ?? "none"} → ${currentToolsHash})`);
      payload.tools = [...AGENT_TOOLS];
      changes.push(`${AGENT_TOOLS.length} tools`);
    } else {
      console.log(`  Tools: up to date (${currentToolsHash})`);
    }

    if (remoteAgent.model.id !== model) {
      console.log(`  Model: changed (${remoteAgent.model.id} → ${model})`);
      payload.model = model;
      changes.push("model");
    } else {
      console.log(`  Model: up to date (${model})`);
    }

    if (Object.keys(payload).length === 0) {
      console.log(`${label} up to date — no changes needed.`);
      return;
    }

    console.log(`Updating ${label.toLowerCase()}: ${changes.join(", ")}...`);
    if (!dryRun) {
      const updated = await updateAgent(apiKey, id, remoteAgent.version, payload);
      onSuccess();
      saveConfig(configPath, config);
      console.log(`✓ ${label} updated to v${updated.version}`);
    } else {
      console.log(`(would update ${label.toLowerCase()})`);
    }
  }

  if (syncDiscovery && syncAgent) {
    console.log("── Discovery Agent ──────────────────────────────");

    const discoveryPrompt = buildDiscoverySystemPrompt({
      evaluateAvailable: true,
      categories: CATEGORIES,
    });
    const discoveryPromptHash = hash(discoveryPrompt);

    await syncAgentConfig({
      label: "Discovery agent",
      agentId,
      prompt: discoveryPrompt,
      promptHash: discoveryPromptHash,
      cachedPromptHash: config.promptHash,
      model: process.env.RELEASED_AGENT_MODEL || "claude-sonnet-4-6",
      remoteAgent: agent!,
      onSuccess: () => {
        config.agentId = agentId;
        config.promptHash = discoveryPromptHash;
        config.toolsHash = currentToolsHash;
      },
    });
    console.log();
  }

  // ── 3. Sync worker agent ─────────────────────────────────────

  if (syncWorker && syncAgent) {
    console.log("── Worker Agent ─────────────────────────────────");
    const workerModel = process.env.RELEASED_WORKER_AGENT_MODEL || "claude-haiku-4-5";
    const workerPrompt = buildWorkerSystemPrompt({ categories: CATEGORIES });
    const workerPromptHash = hash(workerPrompt);
    const workerAgentId = getWorkerAgentId(deployEnv, config);

    if (workerAgentId) {
      const workerAgent = await getAgent(apiKey, workerAgentId);
      await syncAgentConfig({
        label: "Worker agent",
        agentId: workerAgentId,
        prompt: workerPrompt,
        promptHash: workerPromptHash,
        cachedPromptHash: config.workerPromptHash,
        model: workerModel,
        remoteAgent: workerAgent,
        onSuccess: () => {
          config.workerAgentId = workerAgentId;
          config.workerPromptHash = workerPromptHash;
          config.toolsHash = currentToolsHash;
        },
      });
    } else {
      console.log("Creating worker agent...");
      if (!dryRun) {
        const created = await createAgent(apiKey, {
          name: "Releases Worker Agent",
          model: workerModel,
          system: workerPrompt,
          tools: [...AGENT_TOOLS],
          ...(skillIds.length > 0 ? { skills: skillIds } : {}),
        });
        config.workerAgentId = created.id;
        config.workerPromptHash = workerPromptHash;
        saveConfig(configPath, config);
        console.log(`✓ Worker agent created: ${created.id} (v${created.version})`);
        console.log(`  Add to wrangler.jsonc: "ANTHROPIC_WORKER_AGENT_ID": "${created.id}"`);
      } else {
        console.log("(would create worker agent)");
      }
    }
    console.log();
  }

  // ── 4. Sync override agent (--agent-id) ──────────────────────
  // Never touches system prompt or model. Pushes latest skill IDs and
  // AGENT_TOOLS when they have drifted. Skill resource versions are
  // already in place from step 1 and propagate via version: "latest".

  if (agentIdOverride && syncAgent) {
    console.log("── Override Agent ───────────────────────────────");
    const overrideAgent = await getAgent(apiKey, agentIdOverride);

    const payload: {
      skills?: typeof skillIds;
      tools?: unknown[];
    } = {};
    const changes: string[] = [];

    if (skillsChanged > 0) {
      payload.skills = skillIds;
      changes.push(`${skillsChanged} skill(s)`);
    }

    // Override agents aren't tracked in the config, so we don't know their
    // prior tools hash. Always push current AGENT_TOOLS — cheaper than being
    // wrong, and overrides are invoked rarely.
    payload.tools = [...AGENT_TOOLS];
    changes.push(`${AGENT_TOOLS.length} tools`);

    console.log(`  Tools: pushing current (${currentToolsHash})`);
    console.log(`  System prompt: preserved (override never rewrites)`);
    console.log(`  Model: preserved (${overrideAgent.model.id})`);

    console.log(`Updating override agent: ${changes.join(", ")}...`);
    if (!dryRun) {
      const updated = await updateAgent(apiKey, agentIdOverride, overrideAgent.version, payload);
      console.log(`✓ Override agent updated to v${updated.version}`);
    } else {
      console.log("(would update override agent)");
    }
    console.log();
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
