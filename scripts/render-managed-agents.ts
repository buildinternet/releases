#!/usr/bin/env bun
/**
 * Render managed-agent definitions to version-controlled YAML.
 *
 * Produces managed-agents/<kind>.<env>.agent.yaml for the discovery, worker,
 * and coordinator agents in both production and staging. Each file is the exact
 * body the deploy builds — system prompt from the prompt builders, tools from
 * AGENT_TOOLS + the MCP toolset, mcp_servers per environment, and skill refs
 * from scripts/agent-skills[.staging].json. The YAML is GENERATED, never
 * hand-edited: change the source (prompt builders, AGENT_TOOLS, skill IDs) and
 * re-render.
 *
 * Usage:
 *   bun scripts/render-managed-agents.ts            # write the YAML files
 *   bun scripts/render-managed-agents.ts --check    # exit 1 if any file is stale (CI drift gate)
 *
 * This is Phase 1 of the render-then-apply flow: it produces the committed
 * mirror only. Applying the YAML to Anthropic via the `ant` CLI is a later
 * phase and must authenticate with the prod-workspace API key (the same
 * credential CI uses) — `ant auth login` resolves to a different workspace that
 * cannot see the production discovery/worker agents.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { stringify } from "yaml";
import { buildDiscoverySystemPrompt } from "../src/shared/discovery-prompt.js";
import { buildWorkerSystemPrompt } from "../src/shared/worker-prompt.js";
import { buildCoordinatorSystemPrompt } from "../src/shared/coordinator-prompt.js";
import {
  AGENT_TOOLS,
  buildMcpToolset,
  buildMcpServerDefinition,
  type AgentEnv,
} from "../src/shared/agent-tools.js";
import { CATEGORIES } from "@buildinternet/releases-core/categories";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const OUT_DIR = resolve(PROJECT_ROOT, "managed-agents");

type AgentKind = "discovery" | "worker" | "coordinator";

const ENVS: AgentEnv[] = ["production", "staging"];
const KINDS: AgentKind[] = ["discovery", "worker", "coordinator"];

// Default models — mirror the deploy defaults in scripts/sync-agent-skills.ts.
// (The deploy honors RELEASES_AGENT_MODEL / RELEASES_WORKER_AGENT_MODEL env
// overrides, which CI never sets; the committed YAML reflects the canonical
// defaults.)
const MODELS: Record<AgentKind, string> = {
  discovery: "claude-sonnet-5",
  worker: "claude-haiku-4-5",
  coordinator: "claude-sonnet-5",
};

// Worker agent display name referenced *inside* the coordinator's system
// prompt. Matches the constant the deploy passes to buildCoordinatorSystemPrompt
// so the rendered prompt is byte-identical to what ships.
const WORKER_AGENT_NAME = "Releases Worker Agent";

// Live agent `name` field per (env, kind). Production discovery/worker carry
// the legacy "Released" naming (created pre-rename, only ever updated since);
// the prod coordinator and all three staging agents use the current "Releases"
// naming, with staging suffixed " (Staging)". The render-then-apply path feeds
// `name` to `ant beta:agents update`, so these are applied (and rename the live
// agent) on every deploy — keep them matching the intended live names. The
// production discovery/worker names were confirmed against live via the verify
// step (`verify --env production` is all-match).
const AGENT_NAMES: Record<AgentEnv, Record<AgentKind, string>> = {
  production: {
    discovery: "Released Discovery Agent",
    worker: "Released Worker Agent",
    coordinator: "Releases Discovery Coordinator",
  },
  staging: {
    discovery: "Releases Discovery Agent (Staging)",
    worker: "Releases Worker Agent (Staging)",
    coordinator: "Releases Discovery Coordinator (Staging)",
  },
};

// Skill directories in the order the deploy attaches them. Order is preserved
// in the rendered `skills` array to match what ships.
const SKILL_DIRS = [
  "finding-changelogs",
  "managing-sources",
  "parsing-changelogs",
  "analyzing-releases",
  "classify-media-relevance",
];

interface SkillConfig {
  skills: Record<string, { skillId: string; localDir: string }>;
  workerAgentId?: string;
}

function displayTitleFromDir(dir: string): string {
  return dir
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function loadConfig(env: AgentEnv): SkillConfig {
  const path = resolve(
    PROJECT_ROOT,
    env === "staging" ? "scripts/agent-skills.staging.json" : "scripts/agent-skills.json",
  );
  return JSON.parse(readFileSync(path, "utf8")) as SkillConfig;
}

function skillRefs(
  cfg: SkillConfig,
  env: AgentEnv,
): { type: "custom"; skill_id: string; version: "latest" }[] {
  return SKILL_DIRS.map((dir) => {
    const title = displayTitleFromDir(dir);
    const skillId = cfg.skills[title]?.skillId;
    if (!skillId) throw new Error(`Missing skill id for "${title}" in ${env} config`);
    return { type: "custom" as const, skill_id: skillId, version: "latest" as const };
  });
}

function buildSystem(kind: AgentKind): string {
  switch (kind) {
    case "discovery":
      return buildDiscoverySystemPrompt({ evaluateAvailable: true, categories: CATEGORIES });
    case "worker":
      return buildWorkerSystemPrompt({ categories: CATEGORIES });
    case "coordinator":
      return buildCoordinatorSystemPrompt({
        categories: CATEGORIES,
        workerAgentName: WORKER_AGENT_NAME,
      });
  }
}

function buildDefinition(
  kind: AgentKind,
  env: AgentEnv,
  cfg: SkillConfig,
): Record<string, unknown> {
  const def: Record<string, unknown> = {
    name: AGENT_NAMES[env][kind],
    model: MODELS[kind],
    system: buildSystem(kind),
    tools: [...AGENT_TOOLS, buildMcpToolset()],
    mcp_servers: [buildMcpServerDefinition(env)],
    skills: skillRefs(cfg, env),
  };
  if (kind === "coordinator") {
    const workerId = cfg.workerAgentId;
    if (!workerId) throw new Error(`coordinator (${env}): missing workerAgentId in config`);
    def.multiagent = { type: "coordinator", agents: [{ type: "agent", id: workerId }] };
  }
  return def;
}

function fileFor(kind: AgentKind, env: AgentEnv): string {
  return resolve(OUT_DIR, `${kind}.${env}.agent.yaml`);
}

const HEADER =
  "# GENERATED by scripts/render-managed-agents.ts — do not edit by hand.\n" +
  "# Source of truth: the prompt builders (src/shared/*-prompt.ts), AGENT_TOOLS\n" +
  "# (src/shared/agent-tools.ts), and skill IDs (scripts/agent-skills*.json).\n" +
  "# Edit those, then re-run: bun scripts/render-managed-agents.ts\n";

function renderAll(): Map<string, string> {
  const out = new Map<string, string>();
  for (const env of ENVS) {
    const cfg = loadConfig(env);
    for (const kind of KINDS) {
      const body = stringify(buildDefinition(kind, env, cfg), { lineWidth: 0 });
      out.set(fileFor(kind, env), HEADER + body);
    }
  }
  return out;
}

function rel(path: string): string {
  return path.replace(PROJECT_ROOT + "/", "");
}

function main(): void {
  const check = process.argv.includes("--check");
  const rendered = renderAll();

  if (check) {
    const stale = [...rendered].filter(
      ([path, yaml]) => !existsSync(path) || readFileSync(path, "utf8") !== yaml,
    );
    if (stale.length > 0) {
      console.error(
        "Managed-agent YAML is out of date. Re-run: bun scripts/render-managed-agents.ts\n",
      );
      for (const [path] of stale) console.error(`  drift: ${rel(path)}`);
      process.exit(1);
    }
    console.log(`Managed-agent YAML is up to date (${rendered.size} files).`);
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  for (const [path, yaml] of rendered) {
    writeFileSync(path, yaml);
    console.log(`wrote ${rel(path)}`);
  }
}

main();
