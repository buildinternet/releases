#!/usr/bin/env bun
/**
 * Generates /.well-known assets served by the web app:
 *
 *   /.well-known/agent-skills/index.json   — Agent Skills Discovery (RFC v0.2.0)
 *   /.well-known/mcp/server-card.json      — MCP Server Card (SEP-1649)
 *
 * Skills are hosted in the OSS CLI repo (buildinternet/releases-cli) — at build
 * time we fetch each SKILL.md, compute a sha256 digest, and pull the
 * description out of the YAML frontmatter. The MCP server card is derived from
 * workers/mcp/server.json so it stays in sync on version bumps.
 *
 * On fetch failure, the skills index retains the previously-built file rather
 * than aborting the build — a transient GitHub outage shouldn't block deploys.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import matter from "gray-matter";

const WEB_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(WEB_ROOT);

const SKILLS_INDEX_PATH = join(WEB_ROOT, "public/.well-known/agent-skills/index.json");
const SERVER_CARD_PATH = join(WEB_ROOT, "public/.well-known/mcp/server-card.json");

await buildSkillsIndex();
buildMcpServerCard();

async function buildSkillsIndex() {
  // One entry per skill, fetched from its canonical repo (#1090): user-facing
  // skills live in the CLI repo's skills/ tree; operator + owner skills live
  // in this monorepo (.claude/skills/ and skills/ respectively).
  const CLI_REPO = "buildinternet/releases-cli";
  const MONO_REPO = "buildinternet/releases";
  const REF = "main";
  const SKILLS: { name: string; repo: string; dir: string }[] = [
    // Reader (CLI repo)
    { name: "analyzing-releases", repo: CLI_REPO, dir: "skills" },
    { name: "releases-cli", repo: CLI_REPO, dir: "skills" },
    { name: "releases-mcp", repo: CLI_REPO, dir: "skills" },
    // Owner listing (monorepo)
    { name: "creating-releases-json", repo: MONO_REPO, dir: "skills" },
    // Operator (monorepo)
    { name: "classify-media-relevance", repo: MONO_REPO, dir: ".claude/skills" },
    { name: "finding-changelogs", repo: MONO_REPO, dir: ".claude/skills" },
    { name: "managing-sources", repo: MONO_REPO, dir: ".claude/skills" },
    { name: "parsing-changelogs", repo: MONO_REPO, dir: ".claude/skills" },
    { name: "seeding-playbooks", repo: MONO_REPO, dir: ".claude/skills" },
  ];

  try {
    const entries = await Promise.all(
      SKILLS.map(async ({ name, repo, dir }) => {
        const url = `https://raw.githubusercontent.com/${repo}/${REF}/${dir}/${name}/SKILL.md`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Fetch ${url} failed: ${res.status}`);
        const body = await res.text();
        const { data } = matter(body);
        const description =
          typeof data.description === "string" ? data.description.replace(/\s+/g, " ").trim() : "";
        if (!description) throw new Error(`Skill ${name} has no description`);
        return {
          name,
          type: "skill-md" as const,
          description,
          url,
          digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
        };
      }),
    );
    writeJson(SKILLS_INDEX_PATH, {
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: entries,
    });
    console.log(`Agent skills index: ${entries.length} skills → ${SKILLS_INDEX_PATH}`);
  } catch (err) {
    if (existsSync(SKILLS_INDEX_PATH)) {
      console.warn(`Agent skills fetch failed, keeping previous index: ${err}`);
    } else {
      throw err;
    }
  }
}

function buildMcpServerCard() {
  const server = JSON.parse(readFileSync(join(REPO_ROOT, "workers/mcp/server.json"), "utf8"));
  const endpoint = server.remotes?.[0]?.url as string | undefined;
  if (!endpoint) throw new Error("workers/mcp/server.json is missing remotes[0].url");

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
