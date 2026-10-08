#!/usr/bin/env bun
/**
 * Generates /.well-known assets served by the web app:
 *
 *   /.well-known/agent-skills/index.json   — Agent Skills Discovery (RFC v0.2.0)
 *   /.well-known/mcp/server-card.json      — MCP Server Card (SEP-1649)
 *
 * Every skill lives in this monorepo — at build time we read each SKILL.md from
 * the local tree, compute a sha256 digest, and pull the description out of the
 * YAML frontmatter. The emitted `url` points at the raw GitHub copy on main. The
 * MCP server card is derived from apps/mcp/server.json so it stays in sync on
 * version bumps.
 *
 * A missing SKILL.md throws: a skill that moved should fail the build loudly.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import matter from "gray-matter";

const WEB_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(WEB_ROOT));

const SKILLS_INDEX_PATH = join(WEB_ROOT, "public/.well-known/agent-skills/index.json");
const SERVER_CARD_PATH = join(WEB_ROOT, "public/.well-known/mcp/server-card.json");

buildSkillsIndex();
buildMcpServerCard();

function buildSkillsIndex() {
  // One entry per skill, all read from the local tree (#1090): reader skills
  // live in the Claude plugin folder (plugins/claude/releases/skills/), the
  // owner skill in skills/, operator skills in .claude/skills/.
  const REPO = "buildinternet/releases";
  const REF = "main";
  const READER_DIR = "plugins/claude/releases/skills";
  const SKILLS: { name: string; dir: string }[] = [
    // Reader
    { name: "analyzing-releases", dir: READER_DIR },
    { name: "releases-cli", dir: READER_DIR },
    { name: "releases-mcp", dir: READER_DIR },
    // Owner listing
    { name: "creating-releases-json", dir: "skills" },
    // Operator
    { name: "classify-media-relevance", dir: ".claude/skills" },
    { name: "finding-changelogs", dir: ".claude/skills" },
    { name: "managing-sources", dir: ".claude/skills" },
    { name: "parsing-changelogs", dir: ".claude/skills" },
    { name: "seeding-playbooks", dir: ".claude/skills" },
  ];

  const entries = SKILLS.map(({ name, dir }) => {
    const path = join(REPO_ROOT, dir, name, "SKILL.md");
    if (!existsSync(path)) throw new Error(`Skill file missing: ${path}`);
    const body = readFileSync(path, "utf8");
    const { data } = matter(body);
    const description =
      typeof data.description === "string" ? data.description.replace(/\s+/g, " ").trim() : "";
    if (!description) throw new Error(`Skill ${name} has no description`);
    return {
      name,
      type: "skill-md" as const,
      description,
      url: `https://raw.githubusercontent.com/${REPO}/${REF}/${dir}/${name}/SKILL.md`,
      digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    };
  });
  writeJson(SKILLS_INDEX_PATH, {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: entries,
  });
  console.log(`Agent skills index: ${entries.length} skills → ${SKILLS_INDEX_PATH}`);
}

function buildMcpServerCard() {
  const server = JSON.parse(readFileSync(join(REPO_ROOT, "apps/mcp/server.json"), "utf8"));
  const endpoint = server.remotes?.[0]?.url as string | undefined;
  if (!endpoint) throw new Error("apps/mcp/server.json is missing remotes[0].url");

  writeJson(SERVER_CARD_PATH, {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: server.name,
    title: server.title,
    description: server.description,
    version: server.version,
    serverInfo: { name: server.name, version: server.version },
    // Top-level `url` mirrors the connect endpoint. `remotes[].url` / `endpoint`
    // are the MCP-native fields, but some consumers (e.g. integrations.sh) look
    // for a bare `url`, so publish it too.
    url: endpoint,
    endpoint,
    remotes: server.remotes,
    capabilities: { tools: { listChanged: false } },
    repository: server.repository,
  });
  console.log(`MCP server card: ${server.name}@${server.version} → ${SERVER_CARD_PATH}`);
}

function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}
