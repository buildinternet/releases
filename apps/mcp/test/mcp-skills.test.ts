import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { collectSkillFiles, renderSkillBundle, MCP_SKILLS } from "../scripts/skill-sources.js";
import { loadSkillsCatalog } from "../src/skills.js";

async function connect() {
  const catalog = await loadSkillsCatalog();
  const server = new McpServer({ name: "releases-test", version: "0.0.0" });
  (catalog.attach as (s: unknown) => void)(server);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, skills: new SkillsClient(client) };
}

describe("MCP skills", () => {
  it("embedded bundle matches the skill sources (run `bun run mcp:skills:build`)", () => {
    const committed = readFileSync(
      resolve(import.meta.dir, "..", "src", "skill-bundles.ts"),
      "utf8",
    );
    expect(committed).toBe(renderSkillBundle(collectSkillFiles()));
  });

  it("lists every served skill with a verified manifest", async () => {
    const { client, skills } = await connect();
    expect(skills.supported).toBe(true);
    const { skills: listed, invalid } = await skills.list();
    expect(invalid).toEqual([]);
    expect(listed.map((s) => s.frontmatter.name).sort()).toEqual(
      MCP_SKILLS.map((s) => s.name).sort(),
    );
    for (const s of listed) expect(s.uri).toBe(`skill://${s.frontmatter.name}/SKILL.md`);
    await client.close();
  });

  it("reads a SKILL.md and a supporting file, digest-checked", async () => {
    const { client, skills } = await connect();
    const { skill } = await skills.get("skill://creating-releases-json/SKILL.md");
    const main = await skills.read(skill);
    expect(main.verified).toBe(true);
    expect(main.text).toContain("releases.json");
    const schema = await skills.read(skill, "references/schema.json");
    expect(schema.verified).toBe(true);
    expect(JSON.parse(schema.text ?? "")).toHaveProperty("$schema");
    await client.close();
  });
});
