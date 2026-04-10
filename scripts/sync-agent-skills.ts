#!/usr/bin/env bun
/**
 * Deploy the managed agent: sync skills, system prompt, tools, and model.
 *
 * Usage:
 *   bun scripts/sync-agent-skills.ts              # deploy everything
 *   bun scripts/sync-agent-skills.ts --dry-run    # preview without changes
 *   bun scripts/sync-agent-skills.ts --skills     # skills only
 *   bun scripts/sync-agent-skills.ts --agent      # prompt/tools/model only
 *
 * Requires ANTHROPIC_API_KEY in .env or environment.
 * Reads ANTHROPIC_AGENT_ID from env or workers/discovery/wrangler.jsonc.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import { buildDiscoverySystemPrompt } from "../src/shared/discovery-prompt.js";
import { AGENT_TOOLS } from "../src/shared/agent-tools.js";
import { CATEGORIES } from "../src/lib/categories.js";

// ── Config ───────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SKILLS_DIR = resolve(PROJECT_ROOT, "src/agent/skills");
const CONFIG_PATH = resolve(PROJECT_ROOT, "scripts/agent-skills.json");

const SKILL_DIRS = [
  "finding-changelogs",
  "managing-sources",
  "parsing-changelogs",
  "analyzing-releases",
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
    latestVersion: string;
    localDir: string;
    updatedAt: string;
  };
}

interface SkillConfig {
  skills: SkillMapping;
  agentId: string;
  agentVersion?: number;
  promptHash?: string;
  toolsHash?: string;
  lastSyncedAt: string;
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

function getAgentId(): string {
  if (process.env.ANTHROPIC_AGENT_ID) return process.env.ANTHROPIC_AGENT_ID;

  // Read from wrangler.jsonc
  try {
    const wrangler = readFileSync(
      resolve(PROJECT_ROOT, "workers/discovery/wrangler.jsonc"),
      "utf8",
    );
    const match = wrangler.match(/"ANTHROPIC_AGENT_ID":\s*"([^"]+)"/);
    if (match) return match[1];
  } catch { /* ignore */ }

  throw new Error(
    "ANTHROPIC_AGENT_ID not found. Set it in env or workers/discovery/wrangler.jsonc",
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
  const syncSkills = !agentOnly;
  const syncAgent = !skillsOnly;

  const apiKey = getApiKey();
  const agentId = getAgentId();

  console.log(`Agent: ${agentId}`);
  if (dryRun) console.log("DRY RUN — no changes will be made");
  console.log();

  const config = loadConfig() || {
    skills: {},
    agentId,
    lastSyncedAt: "",
  };

  const agent = await getAgent(apiKey, agentId);
  let agentVersion = agent.version;
  const changes: string[] = [];

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
            latestVersion: newVersion.version,
            localDir: dirName,
            updatedAt: new Date().toISOString(),
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
            latestVersion: created.latest_version,
            localDir: dirName,
            updatedAt: new Date().toISOString(),
          };
          skillIds.push({ type: "custom", skill_id: created.id, version: "latest" });
          console.log(`  ✓ Created ${created.id}\n`);
        } else {
          console.log(`  (would create new skill — no cached ID)\n`);
        }
      }
    }
    if (skillsChanged > 0) changes.push(`${skillsChanged} skill(s)`);
  }

  // ── 2. Sync system prompt, tools, model ───────────────────────

  const updatePayload: {
    skills?: typeof skillIds;
    system?: string;
    tools?: unknown[];
    model?: string;
  } = {};

  if (skillsChanged > 0) {
    updatePayload.skills = skillIds;
  }

  if (syncAgent) {
    const currentPrompt = buildDiscoverySystemPrompt({
      evaluateAvailable: true,
      categories: CATEGORIES,
    });
    const currentPromptHash = hash(currentPrompt);
    const currentToolsHash = hash(JSON.stringify(AGENT_TOOLS));
    const currentModel = process.env.RELEASED_AGENT_MODEL || "claude-sonnet-4-6";

    console.log("Agent config:");

    // System prompt
    if (config.promptHash !== currentPromptHash) {
      console.log(`  System prompt: changed (${config.promptHash ?? "none"} → ${currentPromptHash})`);
      updatePayload.system = currentPrompt;
      changes.push("system prompt");
    } else {
      console.log(`  System prompt: up to date (${currentPromptHash})`);
    }

    // Tools
    if (config.toolsHash !== currentToolsHash) {
      console.log(`  Tools: changed (${config.toolsHash ?? "none"} → ${currentToolsHash})`);
      updatePayload.tools = [...AGENT_TOOLS];
      changes.push(`${AGENT_TOOLS.length} tools`);
    } else {
      console.log(`  Tools: up to date (${currentToolsHash})`);
    }

    // Model
    const remoteModel = agent.model.id;
    if (remoteModel !== currentModel) {
      console.log(`  Model: changed (${remoteModel} → ${currentModel})`);
      updatePayload.model = currentModel;
      changes.push("model");
    } else {
      console.log(`  Model: up to date (${currentModel})`);
    }

    config.promptHash = currentPromptHash;
    config.toolsHash = currentToolsHash;
    console.log();
  }

  // ── 3. Push update ────────────────────────────────────────────

  const hasChanges = Object.keys(updatePayload).length > 0;

  if (!hasChanges) {
    console.log("Everything up to date — no changes needed.");
    return;
  }

  console.log(`Updating agent: ${changes.join(", ")}...`);
  if (!dryRun) {
    const updated = await updateAgent(apiKey, agentId, agentVersion, updatePayload);
    config.agentId = agentId;
    config.agentVersion = updated.version;
    config.lastSyncedAt = new Date().toISOString();
    saveConfig(config);
    console.log(`✓ Agent updated to v${updated.version}`);
    console.log(`Config saved to ${CONFIG_PATH}`);
  } else {
    console.log("(would update agent)");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
