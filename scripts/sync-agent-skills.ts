#!/usr/bin/env bun
/**
 * Sync local skills to Anthropic Skills API and attach them to the managed agent.
 *
 * Usage:
 *   bun scripts/sync-agent-skills.ts              # sync all skills
 *   bun scripts/sync-agent-skills.ts --dry-run    # preview without changes
 *
 * Requires ANTHROPIC_API_KEY in .env or environment.
 * Reads ANTHROPIC_AGENT_ID from env or workers/discovery/wrangler.jsonc.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, basename } from "path";

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
): Promise<{ version: number; skills: unknown[] }> {
  const res = await fetch(`${ANTHROPIC_API}/v1/agents/${agentId}`, {
    headers: { ...AGENT_HEADERS, "x-api-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to get agent ${agentId}: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as { version: number; skills: unknown[] };
}

async function updateAgentSkills(
  apiKey: string,
  agentId: string,
  agentVersion: number,
  skills: { type: string; skill_id: string; version: string }[],
): Promise<{ version: number }> {
  const res = await fetch(`${ANTHROPIC_API}/v1/agents/${agentId}`, {
    method: "POST",
    headers: { ...AGENT_HEADERS, "x-api-key": apiKey },
    body: JSON.stringify({
      version: agentVersion,
      skills,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to update agent skills: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as { version: number };
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const apiKey = getApiKey();
  const agentId = getAgentId();

  console.log(`Agent: ${agentId}`);
  console.log(`Skills dir: ${SKILLS_DIR}`);
  if (dryRun) console.log("DRY RUN — no changes will be made\n");

  // 1. List existing custom skills to find matches by display_title
  const existing = await listCustomSkills(apiKey);
  const existingByTitle = new Map(existing.map((s) => [s.display_title, s]));

  console.log(`Found ${existing.length} existing custom skill(s)\n`);

  // 2. Sync each local skill
  const config = loadConfig() || {
    skills: {},
    agentId,
    lastSyncedAt: "",
  };
  const skillIds: { type: string; skill_id: string; version: string }[] = [];

  for (const dirName of SKILL_DIRS) {
    const displayTitle = displayTitleFromDir(dirName);
    const { content } = readSkillFile(dirName);
    const remote = existingByTitle.get(displayTitle);

    if (remote) {
      // Skill exists — create a new version
      console.log(`↻ ${displayTitle} (${remote.id}) — creating new version`);
      if (!dryRun) {
        const newVersion = await createSkillVersion(
          apiKey,
          remote.id,
          content,
          dirName,
        );
        config.skills[displayTitle] = {
          skillId: remote.id,
          latestVersion: newVersion.version,
          localDir: dirName,
          updatedAt: new Date().toISOString(),
        };
        skillIds.push({
          type: "custom",
          skill_id: remote.id,
          version: "latest",
        });
        console.log(`  ✓ Version ${newVersion.version}\n`);
      } else {
        skillIds.push({
          type: "custom",
          skill_id: remote.id,
          version: "latest",
        });
        console.log(`  (would create new version)\n`);
      }
    } else {
      // Check local config for a previously-created skill ID
      const cached = config.skills[displayTitle];
      if (cached?.skillId) {
        // We have a cached ID — create a new version
        console.log(`↻ ${displayTitle} (${cached.skillId}) — creating new version (from cache)`);
        if (!dryRun) {
          const newVersion = await createSkillVersion(
            apiKey,
            cached.skillId,
            content,
            dirName,
          );
          cached.latestVersion = newVersion.version;
          cached.updatedAt = new Date().toISOString();
          skillIds.push({
            type: "custom",
            skill_id: cached.skillId,
            version: "latest",
          });
          console.log(`  ✓ Version ${newVersion.version}\n`);
        } else {
          skillIds.push({
            type: "custom",
            skill_id: cached.skillId,
            version: "latest",
          });
          console.log(`  (would create new version)\n`);
        }
      } else {
        // Skill doesn't exist anywhere — create it
        console.log(`+ ${displayTitle} — creating new skill`);
        if (!dryRun) {
          const created = await createSkill(apiKey, displayTitle, content, dirName);
          config.skills[displayTitle] = {
            skillId: created.id,
            latestVersion: created.latest_version,
            localDir: dirName,
            updatedAt: new Date().toISOString(),
          };
          skillIds.push({
            type: "custom",
            skill_id: created.id,
            version: "latest",
          });
          console.log(`  ✓ Created ${created.id}\n`);
        } else {
          console.log(`  (would create new skill — no cached ID)\n`);
        }
      }
    }
  }

  // 3. Attach skills to the agent
  console.log(`Attaching ${skillIds.length} skill(s) to agent...`);
  if (!dryRun) {
    const agent = await getAgent(apiKey, agentId);
    const updated = await updateAgentSkills(
      apiKey,
      agentId,
      agent.version,
      skillIds,
    );
    config.agentId = agentId;
    config.agentVersion = updated.version;
    config.lastSyncedAt = new Date().toISOString();
    saveConfig(config);
    console.log(`✓ Agent updated to v${updated.version}`);
    console.log(`Config saved to ${CONFIG_PATH}`);
  } else {
    console.log("Skills that would be attached:");
    for (const s of skillIds) {
      console.log(`  - ${s.skill_id}`);
    }
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
