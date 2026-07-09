#!/usr/bin/env bun
/**
 * Deploy managed agents: sync skills, system prompt, tools, and model.
 *
 * Manages three agents per environment:
 *   - Discovery agent (Sonnet) — single-agent onboarding (legacy path)
 *   - Worker agent (Haiku) — fetches, updates, mechanical operations
 *   - Coordinator agent (Sonnet) — multi-agent onboarding; delegates fetches
 *     to the worker via the agent_toolset_20260401 tool. Created lazily.
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
 *   bun scripts/sync-agent-skills.ts --coordinator    # coordinator agent only
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
import { buildDiscoverySystemPrompt } from "../managed-agents/src/shared/discovery-prompt.js";
import { buildWorkerSystemPrompt } from "../managed-agents/src/shared/worker-prompt.js";
import { buildCoordinatorSystemPrompt } from "../managed-agents/src/shared/coordinator-prompt.js";
import {
  AGENT_TOOLS,
  buildMcpServerDefinition,
  buildMcpToolset,
} from "../managed-agents/src/shared/agent-tools.js";
import { CATEGORIES } from "@buildinternet/releases-core/categories";
import { fetchWithRetry } from "./fetch-retry.js";

// Display name of the worker agent the coordinator delegates to. Must match
// the `name` used when creating the worker agent below.
const WORKER_AGENT_NAME = "Releases Worker Agent";

// AGENT_TOOLS already includes an `agent_toolset_20260401` entry (idx 0),
// so the coordinator inherits it from the shared list. The toolset is a
// no-op on agents without a `multiagent.coordinator` config, which is why
// discovery + worker can carry it without becoming coordinators.

// ── Config ───────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SKILLS_DIR = resolve(PROJECT_ROOT, ".claude/skills");

type DeployEnv = "production" | "staging";
type AgentKind = "discovery" | "worker" | "coordinator";

// Render-then-apply path. When set, existing agents are updated by feeding the
// committed managed-agents/<kind>.<env>.agent.yaml to `ant beta:agents update`
// instead of POSTing a JS-built payload via fetch. Default off — the fetch path
// stays the rollback. Enabled in CI via the workflow's apply_via_ant dispatch
// input (or `--apply-via-ant` locally). The committed YAML is guaranteed current
// by the CI render `--check` drift gate. See docs/architecture/agents.md.
const APPLY_VIA_ANT =
  process.env.AGENT_APPLY_VIA_ANT === "1" || process.argv.includes("--apply-via-ant");

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
  "classify-media-relevance",
];

const MEMORY_STORES = [
  {
    key: "errata",
    name: "releases-errata",
    envVar: "MEMORY_STORE_ERRATA_ID",
    description:
      "Per-organization corrections and observations layered over playbook notes. " +
      "Paths: /orgs/<org_id>/errata.md (trusted rules), " +
      "/orgs/<org_id>/observations.md (unvalidated priors), " +
      "/discovery/global.md (discovery-scope notes, written before an org is resolved).",
  },
  {
    key: "toolNotes",
    name: "releases-tool-notes",
    envVar: "MEMORY_STORE_TOOL_NOTES_ID",
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
  workerAgentId?: string;
  coordinatorAgentId?: string;
  memoryStores?: {
    errata?: string;
    toolNotes?: string;
  };
  environmentId?: string;
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

function getCoordinatorAgentId(env: DeployEnv, config: SkillConfig | null): string | null {
  if (env === "staging") {
    return config?.coordinatorAgentId ?? process.env.ANTHROPIC_COORDINATOR_AGENT_ID ?? null;
  }
  // No `readWranglerVar` fallback for prod: the coordinator var only exists
  // in the [env.staging] block today, and `readWranglerVar` matches the first
  // regex hit in the file regardless of block, so it would silently return
  // the staging coordinator on a prod sync. Operators wire prod via env or
  // the cached config; explicit beats implicit.
  return process.env.ANTHROPIC_COORDINATOR_AGENT_ID ?? config?.coordinatorAgentId ?? null;
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
  const res = await fetchWithRetry(
    `${ANTHROPIC_API}/v1/skills?source=custom`,
    { headers: { ...HEADERS, "x-api-key": apiKey } },
    { label: "list skills" },
  );
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

  const res = await fetchWithRetry(
    `${ANTHROPIC_API}/v1/skills`,
    { method: "POST", headers: { ...HEADERS, "x-api-key": apiKey }, body: form },
    { label: `create skill "${displayTitle}"` },
  );
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

  const res = await fetchWithRetry(
    `${ANTHROPIC_API}/v1/skills/${skillId}/versions`,
    { method: "POST", headers: { ...HEADERS, "x-api-key": apiKey }, body: form },
    { label: `create version for ${skillId}` },
  );
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
    mcp_servers?: { name: string; type: "url"; url: string }[];
    skills?: { type: string; skill_id: string; version: string }[];
    multiagent?: {
      type: "coordinator";
      agents: { type: "agent"; id: string; version?: number }[];
    };
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
    mcp_servers?: { name: string; type: "url"; url: string }[] | null;
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

/**
 * Apply an existing agent by feeding its committed YAML to `ant beta:agents
 * update` (the render-then-apply path; gated by APPLY_VIA_ANT). The YAML is the
 * full body — name, model, system, tools, mcp_servers, skills, and the
 * coordinator's multiagent roster — so unlike the fetch `updateAgent` it also
 * (idempotently) re-asserts name + roster; both are no-ops when unchanged, and
 * the API re-resolves the roster's worker reference to its current version.
 *
 * `ant` authenticates from ANTHROPIC_API_KEY (same key the fetch path uses) and
 * prints an auth-source note to stderr, so only stdout is parsed. This path uses
 * the YAML's model verbatim and ignores RELEASES_*_AGENT_MODEL overrides — CI
 * never sets them, and the committed YAML is kept current by the render
 * `--check` drift gate.
 */
function antUpdateAgent(
  kind: AgentKind,
  env: DeployEnv,
  agentId: string,
  version: number,
): { version: number } {
  const yamlPath = resolve(PROJECT_ROOT, "managed-agents", `${kind}.${env}.agent.yaml`);
  const body = readFileSync(yamlPath, "utf8");
  const res = Bun.spawnSync(
    [
      "ant",
      "beta:agents",
      "update",
      "--agent-id",
      agentId,
      "--version",
      String(version),
      "--format",
      "json",
    ],
    { stdin: Buffer.from(body) },
  );
  const stdout = res.stdout.toString().trim();
  let parsed: { id?: string; version?: number; error?: unknown; type?: string };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `ant update ${agentId}: unparseable response (exit ${res.exitCode}): ${stdout || res.stderr.toString()}`,
    );
  }
  if (res.exitCode !== 0 || parsed.error || parsed.type === "error" || !parsed.id) {
    throw new Error(`ant update ${agentId} failed: ${stdout}`);
  }
  return { version: parsed.version as number };
}

/**
 * Apply an environment by feeding its committed YAML to `ant beta:environments
 * update` (ant-path-only; gated by APPLY_VIA_ANT). Environments take no version
 * (no optimistic-locking token), so the call is simpler than antUpdateAgent.
 * Parses stdout only — ant prints an auth-source note to stderr. A no-op while
 * the committed name/config match live (names are preserved verbatim).
 */
function antUpdateEnvironment(env: DeployEnv, environmentId: string): { id: string } {
  const yamlPath = resolve(PROJECT_ROOT, "managed-agents", `${env}.environment.yaml`);
  const body = readFileSync(yamlPath, "utf8");
  const res = Bun.spawnSync(
    ["ant", "beta:environments", "update", "--environment-id", environmentId, "--format", "json"],
    { stdin: Buffer.from(body) },
  );
  const stdout = res.stdout.toString().trim();
  let parsed: { id?: string; error?: unknown; type?: string };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `ant env update ${environmentId}: unparseable response (exit ${res.exitCode}): ${stdout || res.stderr.toString()}`,
    );
  }
  if (res.exitCode !== 0 || parsed.error || parsed.type === "error" || !parsed.id) {
    throw new Error(`ant env update ${environmentId} failed: ${stdout}`);
  }
  return { id: parsed.id };
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

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const skillsOnly = process.argv.includes("--skills");
  const agentOnly = process.argv.includes("--agent");
  const memoryStoresOnly = process.argv.includes("--memory-stores");
  const discoveryOnly = process.argv.includes("--discovery");
  const workerOnly = process.argv.includes("--worker");
  const coordinatorOnly = process.argv.includes("--coordinator");

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
  // --agent-id disables the default targets. Only the override agent is touched.
  // Per-agent flags are mutually exclusive selectors among discovery/worker/coordinator.
  const anyAgentScope = discoveryOnly || workerOnly || coordinatorOnly;
  const syncDiscovery = !agentIdOverride && (!anyAgentScope || discoveryOnly);
  const syncWorker = !agentIdOverride && (!anyAgentScope || workerOnly);
  const syncCoordinator = !agentIdOverride && (!anyAgentScope || coordinatorOnly);

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

  // When --discovery / --worker / --coordinator runs solo, syncSkills is
  // false. Backfill from the cached config so the agent payload still
  // attaches the latest known skill IDs ("latest" version is resolved at
  // eval time, so any post-deploy skill version bump applies automatically).
  // Without this, create-on-first-deploy would mint an agent with zero
  // skills, and update payloads would be skill-less too if we ever
  // re-enabled the skills field on a syncSkills=false update path.
  if (!syncSkills) {
    for (const { skillId } of Object.values(config.skills)) {
      skillIds.push({ type: "custom", skill_id: skillId, version: "latest" });
    }
  }

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
  // Never updates name/description on existing stores — edit those in the
  // Anthropic console if needed.

  if (syncMemoryStores) {
    console.log("── Memory Stores ────────────────────────────────");
    config.memoryStores ??= {};
    const allCached = MEMORY_STORES.every((def) => config.memoryStores?.[def.key]);
    const byName = allCached
      ? new Map<string, ApiMemoryStore>()
      : new Map((await listMemoryStores(apiKey)).map((s) => [s.name, s]));

    for (const def of MEMORY_STORES) {
      const displayName = `${def.name}${titleSuffix}`;
      const existingId = byName.get(displayName)?.id ?? config.memoryStores[def.key];

      if (existingId) {
        console.log(`✓ ${displayName} (${existingId}) — exists`);
        config.memoryStores[def.key] = existingId;
      } else if (dryRun) {
        console.log(`+ ${displayName} — (would create memory store)`);
      } else {
        console.log(`+ ${displayName} — creating`);
        // oxlint-disable-next-line no-await-in-loop -- writes run sequentially so a mid-loop failure leaves a recoverable partial state
        const created = await createMemoryStore(apiKey, displayName, def.description);
        config.memoryStores[def.key] = created.id;
        console.log(`  ✓ Created ${created.id}`);
      }
    }

    const missingInWrangler = MEMORY_STORES.map((def) => ({
      envVar: def.envVar,
      id: config.memoryStores![def.key],
    })).filter(({ envVar, id }) => id && readWranglerVar(envVar) !== id);
    if (missingInWrangler.length > 0) {
      console.log();
      console.log("  ℹ wrangler.jsonc vars to set for the discovery worker:");
      for (const { envVar, id } of missingInWrangler) {
        console.log(`    "${envVar}": "${id}"`);
      }
    }

    if (!dryRun) saveConfig(configPath, config);
    console.log();
  }

  // ── 2. Sync agents ─────────────────────────────────────────────

  interface AgentSyncParams {
    label: string;
    kind: AgentKind;
    agentId: string;
    prompt: string;
    model: string;
    remoteAgent: { version: number; model: { id: string } };
    onSuccess: () => void;
  }

  /**
   * Push prompt + tools + model + skills to an agent.
   *
   * Always pushes system prompt and tools — the skip-if-hash-matches
   * optimization was removed when we switched to auto-deploy-on-push
   * (#552). The workflow only runs when one of the source files actually
   * changed, so there's nothing to skip; trading one idempotent API call
   * for zero local state drift.
   */
  async function syncAgentConfig(params: AgentSyncParams): Promise<void> {
    const { label, kind, agentId: id, prompt, model, remoteAgent, onSuccess } = params;
    const tools = [...AGENT_TOOLS, buildMcpToolset()];
    const mcpServers = [buildMcpServerDefinition(deployEnv)];
    const payload: {
      skills?: typeof skillIds;
      system: string;
      tools: unknown[];
      mcp_servers?: { name: string; type: "url"; url: string }[];
      model?: string;
    } = {
      system: prompt,
      tools,
      mcp_servers: mcpServers,
    };
    const changes = ["system prompt", `${tools.length} tools (incl. mcp_toolset)`, "mcp_servers"];
    // Only push skills when this run actually rebuilt the skill set. Without
    // this guard, a `--discovery`/`--worker`-only run with --agent (which
    // leaves syncSkills=false) and a stale/empty cached config would write
    // `skills: []` and strip every skill from the agent. Mirrors the
    // coordinator-block guard below.
    if (syncSkills) {
      payload.skills = skillIds;
      changes.unshift(`${skillIds.length} skill(s)`);
    }

    if (remoteAgent.model.id !== model) {
      console.log(`  Model: changed (${remoteAgent.model.id} → ${model})`);
      payload.model = model;
      changes.push("model");
    } else {
      console.log(`  Model: up to date (${model})`);
    }

    console.log(
      `Updating ${label.toLowerCase()}${APPLY_VIA_ANT ? " (via ant)" : ""}: ${changes.join(", ")}...`,
    );
    if (!dryRun) {
      const updated = APPLY_VIA_ANT
        ? antUpdateAgent(kind, deployEnv, id, remoteAgent.version)
        : await updateAgent(apiKey, id, remoteAgent.version, payload);
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

    await syncAgentConfig({
      label: "Discovery agent",
      kind: "discovery",
      agentId,
      prompt: discoveryPrompt,
      model:
        (process.env.RELEASES_AGENT_MODEL ?? process.env.RELEASED_AGENT_MODEL) || "claude-sonnet-5",
      remoteAgent: agent!,
      onSuccess: () => {
        config.agentId = agentId;
      },
    });
    console.log();
  }

  // ── 3. Sync worker agent ─────────────────────────────────────

  if (syncWorker && syncAgent) {
    console.log("── Worker Agent ─────────────────────────────────");
    const workerModel =
      (process.env.RELEASES_WORKER_AGENT_MODEL ?? process.env.RELEASED_WORKER_AGENT_MODEL) ||
      "claude-haiku-4-5";
    const workerPrompt = buildWorkerSystemPrompt({ categories: CATEGORIES });
    const workerAgentId = getWorkerAgentId(deployEnv, config);

    if (workerAgentId) {
      const workerAgent = await getAgent(apiKey, workerAgentId);
      await syncAgentConfig({
        label: "Worker agent",
        kind: "worker",
        agentId: workerAgentId,
        prompt: workerPrompt,
        model: workerModel,
        remoteAgent: workerAgent,
        onSuccess: () => {
          config.workerAgentId = workerAgentId;
        },
      });
    } else {
      console.log("Creating worker agent...");
      if (!dryRun) {
        const created = await createAgent(apiKey, {
          name: "Releases Worker Agent",
          model: workerModel,
          system: workerPrompt,
          tools: [...AGENT_TOOLS, buildMcpToolset()],
          mcp_servers: [buildMcpServerDefinition(deployEnv)],
          ...(skillIds.length > 0 ? { skills: skillIds } : {}),
        });
        config.workerAgentId = created.id;
        saveConfig(configPath, config);
        console.log(`✓ Worker agent created: ${created.id} (v${created.version})`);
        console.log(`  Add to wrangler.jsonc: "ANTHROPIC_WORKER_AGENT_ID": "${created.id}"`);
      } else {
        console.log("(would create worker agent)");
      }
    }
    console.log();
  }

  // ── 4. Sync coordinator agent ─────────────────────────────────
  // The coordinator delegates fetches to the worker via agent_toolset_20260401.
  // It must be created AFTER the worker exists — its multiagent roster
  // references the worker agent ID. On update, prompt/tools/skills/model are
  // pushed the same way as the other agents; the multiagent roster is set
  // only at creation (the worker agent ID is stable).

  if (syncCoordinator && syncAgent) {
    console.log("── Coordinator Agent ────────────────────────────");
    const coordinatorModel =
      (process.env.RELEASES_AGENT_MODEL ?? process.env.RELEASED_AGENT_MODEL) || "claude-sonnet-5";
    const coordinatorPrompt = buildCoordinatorSystemPrompt({
      categories: CATEGORIES,
      workerAgentName: WORKER_AGENT_NAME,
    });
    const coordinatorTools: unknown[] = [...AGENT_TOOLS, buildMcpToolset()];
    const coordinatorMcpServers = [buildMcpServerDefinition(deployEnv)];
    const coordinatorAgentId = getCoordinatorAgentId(deployEnv, config);
    const workerAgentIdForRoster = getWorkerAgentId(deployEnv, config);

    if (coordinatorAgentId) {
      const coordinatorAgent = await getAgent(apiKey, coordinatorAgentId);
      // Reuse syncAgentConfig but with the coordinator tool list — overrides
      // the AGENT_TOOLS-only payload by patching tools after the helper builds
      // the changes summary. Cleanest path is a tiny inline duplicate so the
      // helper stays focused.
      const payload: {
        skills?: typeof skillIds;
        system: string;
        tools: unknown[];
        mcp_servers?: { name: string; type: "url"; url: string }[];
        model?: string;
      } = {
        system: coordinatorPrompt,
        tools: coordinatorTools,
        mcp_servers: coordinatorMcpServers,
      };
      // Only push skills when this run actually rebuilt the skill set. Without
      // this guard, a `--coordinator`-only run (which leaves syncSkills=false
      // and skillIds=[]) would write `skills: []` and strip every skill from
      // the agent.
      const changes = [
        "system prompt",
        `${coordinatorTools.length} tools (incl. mcp_toolset)`,
        "mcp_servers",
      ];
      if (syncSkills) {
        payload.skills = skillIds;
        changes.unshift(`${skillIds.length} skill(s)`);
      }
      if (coordinatorAgent.model.id !== coordinatorModel) {
        console.log(`  Model: changed (${coordinatorAgent.model.id} → ${coordinatorModel})`);
        payload.model = coordinatorModel;
        changes.push("model");
      } else {
        console.log(`  Model: up to date (${coordinatorModel})`);
      }
      console.log(
        `Updating coordinator agent${APPLY_VIA_ANT ? " (via ant)" : ""}: ${changes.join(", ")}...`,
      );
      if (!dryRun) {
        const updated = APPLY_VIA_ANT
          ? antUpdateAgent("coordinator", deployEnv, coordinatorAgentId, coordinatorAgent.version)
          : await updateAgent(apiKey, coordinatorAgentId, coordinatorAgent.version, payload);
        config.coordinatorAgentId = coordinatorAgentId;
        saveConfig(configPath, config);
        console.log(`✓ Coordinator agent updated to v${updated.version}`);
      } else {
        console.log("(would update coordinator agent)");
      }
    } else if (!workerAgentIdForRoster) {
      console.log(
        "⚠ Skipping coordinator creation: worker agent must exist first " +
          "(multiagent roster references the worker agent ID).",
      );
    } else {
      console.log(`Creating coordinator agent (worker=${workerAgentIdForRoster})...`);
      if (!dryRun) {
        const created = await createAgent(apiKey, {
          name: "Releases Discovery Coordinator",
          model: coordinatorModel,
          system: coordinatorPrompt,
          tools: coordinatorTools,
          mcp_servers: coordinatorMcpServers,
          ...(skillIds.length > 0 ? { skills: skillIds } : {}),
          multiagent: {
            type: "coordinator",
            agents: [{ type: "agent", id: workerAgentIdForRoster }],
          },
        });
        config.coordinatorAgentId = created.id;
        saveConfig(configPath, config);
        console.log(`✓ Coordinator agent created: ${created.id} (v${created.version})`);
        console.log(`  Add to wrangler.jsonc: "ANTHROPIC_COORDINATOR_AGENT_ID": "${created.id}"`);
      } else {
        console.log("(would create coordinator agent)");
      }
    }
    console.log();
  }

  // ── Apply environment ────────────────────────────────────────
  // Environments are applied ant-path-only (no fetch/REST equivalent). With
  // APPLY_VIA_ANT off, environments are left untouched — the historical default.
  // A no-op while the committed name/config match live (names preserved verbatim).
  if (syncAgent && APPLY_VIA_ANT) {
    console.log("── Environment ──────────────────────────────────");
    const environmentId = config.environmentId;
    if (!environmentId) {
      console.log("⚠ Skipping environment apply: no environmentId in config.");
    } else if (dryRun) {
      console.log(`(would apply environment ${environmentId} via ant)`);
    } else {
      console.log(`Applying environment (via ant): ${environmentId}...`);
      const updated = antUpdateEnvironment(deployEnv, environmentId);
      console.log(`✓ Environment applied: ${updated.id}`);
    }
    console.log();
  }

  // ── 5. Sync override agent (--agent-id) ──────────────────────
  // Never touches system prompt or model. Pushes latest skill IDs and
  // AGENT_TOOLS when they have drifted. Skill resource versions are
  // already in place from step 1 and propagate via version: "latest".

  if (agentIdOverride && syncAgent) {
    console.log("── Override Agent ───────────────────────────────");
    const overrideAgent = await getAgent(apiKey, agentIdOverride);

    const payload: {
      skills?: typeof skillIds;
      tools?: unknown[];
      mcp_servers?: { name: string; type: "url"; url: string }[];
    } = {};
    const changes: string[] = [];

    if (skillsChanged > 0) {
      payload.skills = skillIds;
      changes.push(`${skillsChanged} skill(s)`);
    }

    const overrideTools = [...AGENT_TOOLS, buildMcpToolset()];
    payload.tools = overrideTools;
    payload.mcp_servers = [buildMcpServerDefinition(deployEnv)];
    changes.push(`${overrideTools.length} tools (incl. mcp_toolset)`, "mcp_servers");

    console.log(`  Tools: pushing current`);
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
