#!/usr/bin/env bun
/**
 * Deploy managed agents: sync skills, system prompt, tools, and model.
 *
 * Manages two agents:
 *   - Discovery agent (Sonnet) — onboarding, evaluation, judgment tasks
 *   - Worker agent (Haiku) — fetches, updates, mechanical operations
 *
 * Usage:
 *   bun scripts/sync-agent-skills.ts                  # deploy both agents
 *   bun scripts/sync-agent-skills.ts --dry-run        # preview without changes
 *   bun scripts/sync-agent-skills.ts --skills         # skills only
 *   bun scripts/sync-agent-skills.ts --agent          # prompt/tools/model only
 *   bun scripts/sync-agent-skills.ts --discovery      # discovery agent only
 *   bun scripts/sync-agent-skills.ts --worker         # worker agent only
 *
 * Requires ANTHROPIC_API_KEY in .env or environment.
 * Reads ANTHROPIC_AGENT_ID from env or workers/discovery/wrangler.jsonc.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import { buildDiscoverySystemPrompt } from "../src/shared/discovery-prompt.js";
import { buildWorkerSystemPrompt } from "../src/shared/worker-prompt.js";
import { AGENT_TOOLS } from "../src/shared/agent-tools.js";
import { CATEGORIES } from "@releases/core-internal/categories";

// ── Config ───────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SKILLS_DIR = resolve(PROJECT_ROOT, "src/agent/skills");
const CONFIG_PATH = resolve(PROJECT_ROOT, "scripts/agent-skills.json");

const SKILL_DIRS = [
  "finding-changelogs",
  "managing-sources",
  "parsing-changelogs",
  "analyzing-releases",
  "classify-media-relevance",
];

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
}

interface ApiSkill {
  id: string;
  display_title: string;
  source: string;
  latest_version: string;
}

// ── Helpers ──────────────────────────────────────────────────────

function loadConfig(): SkillConfig | null {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveConfig(cfg: SkillConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // Try loading from .env
    try {
      const envFile = readFileSync(resolve(PROJECT_ROOT, ".env"), "utf8");
      const match = envFile.match(/^ANTHROPIC_API_KEY=(.+)$/m);
      if (match) return match[1].trim();
    } catch { /* ignore */ }
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
  } catch { /* ignore */ }
  return null;
}

function getAgentId(): string {
  const id = process.env.ANTHROPIC_AGENT_ID ?? readWranglerVar("ANTHROPIC_AGENT_ID");
  if (!id) {
    throw new Error(
      "ANTHROPIC_AGENT_ID not found. Set it in env or workers/discovery/wrangler.jsonc",
    );
  }
  return id;
}

function getWorkerAgentId(): string | null {
  return (
    process.env.ANTHROPIC_WORKER_AGENT_ID ??
    readWranglerVar("ANTHROPIC_WORKER_AGENT_ID") ??
    loadConfig()?.workerAgentId ??
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
  form.append(
    "files[]",
    new Blob([skillFile]),
    `${dirName}/SKILL.md`,
  );

  const res = await fetch(`${ANTHROPIC_API}/v1/skills`, {
    method: "POST",
    headers: { ...HEADERS, "x-api-key": apiKey },
    body: form,
  });
  if (!res.ok) {
    throw new Error(
      `Failed to create skill "${displayTitle}": ${res.status} ${await res.text()}`,
    );
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
  form.append(
    "files[]",
    new Blob([skillFile]),
    `${dirName}/SKILL.md`,
  );

  const res = await fetch(`${ANTHROPIC_API}/v1/skills/${skillId}/versions`, {
    method: "POST",
    headers: { ...HEADERS, "x-api-key": apiKey },
    body: form,
  });
  if (!res.ok) {
    throw new Error(
      `Failed to create version for ${skillId}: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as { version: string };
}

async function getAgent(
  apiKey: string,
  agentId: string,
): Promise<{ version: number; skills: unknown[]; system: string; tools: unknown[]; model: { id: string; speed?: string } }> {
  const res = await fetch(`${ANTHROPIC_API}/v1/agents/${agentId}`, {
    headers: { ...AGENT_HEADERS, "x-api-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to get agent ${agentId}: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as { version: number; skills: unknown[]; system: string; tools: unknown[]; model: { id: string; speed?: string } };
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
    throw new Error(
      `Failed to create agent: ${res.status} ${await res.text()}`,
    );
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
    throw new Error(
      `Failed to update agent: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as { version: number };
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
  const discoveryOnly = process.argv.includes("--discovery");
  const workerOnly = process.argv.includes("--worker");
  const syncSkills = !agentOnly;
  const syncAgent = !skillsOnly;
  const syncDiscovery = !workerOnly;
  const syncWorker = !discoveryOnly;

  const apiKey = getApiKey();
  const agentId = getAgentId();

  if (syncDiscovery) console.log(`Discovery agent: ${agentId}`);
  if (dryRun) console.log("DRY RUN — no changes will be made");
  console.log();

  const config = loadConfig() || {
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
      const displayTitle = displayTitleFromDir(dirName);
      const { content } = readSkillFile(dirName);
      const remote = existingByTitle.get(displayTitle);
      const cached = config.skills[displayTitle];
      const existingId = remote?.id ?? cached?.skillId;

      if (existingId) {
        console.log(`↻ ${displayTitle} (${existingId}) — pushing new version`);
        skillsChanged++;
        if (!dryRun) {
          const newVersion = await createSkillVersion(apiKey, existingId, content, dirName);
          config.skills[displayTitle] = {
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
          const created = await createSkill(apiKey, displayTitle, content, dirName);
          config.skills[displayTitle] = {
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

    if (!dryRun) saveConfig(config);
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
    const { label, agentId: id, prompt, promptHash, cachedPromptHash, model, remoteAgent, onSuccess } = params;
    const payload: { skills?: typeof skillIds; system?: string; tools?: unknown[]; model?: string } = {};
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
      saveConfig(config);
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
    const workerAgentId = getWorkerAgentId();

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
          name: "Released Worker Agent",
          model: workerModel,
          system: workerPrompt,
          tools: [...AGENT_TOOLS],
          ...(skillIds.length > 0 ? { skills: skillIds } : {}),
        });
        config.workerAgentId = created.id;
        config.workerPromptHash = workerPromptHash;
        saveConfig(config);
        console.log(`✓ Worker agent created: ${created.id} (v${created.version})`);
        console.log(`  Add to wrangler.jsonc: "ANTHROPIC_WORKER_AGENT_ID": "${created.id}"`);
      } else {
        console.log("(would create worker agent)");
      }
    }
    console.log();
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
