/**
 * Word-boundary entity matching on the MCP `search` tool (tools.ts), parity
 * with the /v1/search entity sections (#1583/#1586 → #1587). The org / product
 * / source candidate fetches still LIKE %q% in SQL, but now post-filter and
 * rank through `rankEntityCandidates` (@releases/lib/entity-match) — the same
 * helper the API worker uses — so an MCP `search` for "ai" no longer surfaces
 * every `.ai` TLD (CodeRabbit, Granola) or mid-word hit (React Em·ai·l)
 * alphabetically. Fixtures mirror the API test's live noise audit.
 *
 * Without Vectorize bindings the release path degrades to lexical; these tests
 * only request `orgs` / `catalog`, so the FTS path is never exercised.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  organizations,
  products,
  sources,
  domainAliases,
} from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import { search } from "../../workers/mcp/src/tools.js";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = createTestDb();
  await testDb.db.insert(organizations).values([
    // Legitimate "ai" hits: word/camel-boundary names or the AI category.
    { id: "org_openai", slug: "openai", name: "OpenAI", domain: "openai.com", category: "AI" },
    { id: "org_xai", slug: "xai", name: "xAI", domain: "x.ai", category: "AI" },
    {
      id: "org_moonshot",
      slug: "moonshot-ai",
      name: "Moonshot AI",
      domain: "moonshot.ai",
      category: "AI",
    },
    {
      id: "org_anthropic",
      slug: "anthropic",
      name: "Anthropic",
      domain: "anthropic.com",
      category: "AI",
    },
    // The noise set: matched LIKE %ai% only via the .ai TLD.
    {
      id: "org_coderabbit",
      slug: "coderabbit",
      name: "CodeRabbit",
      domain: "coderabbit.ai",
      category: "Developer Tools",
    },
    {
      id: "org_granola",
      slug: "granola",
      name: "Granola",
      domain: "granola.ai",
      category: "Productivity",
    },
  ]);
  await testDb.db
    .insert(domainAliases)
    .values([{ id: "da_claude", domain: "claude.ai", orgId: "org_anthropic" }]);
  await testDb.db.insert(products).values([
    { id: "prod_aisdk", slug: "ai-sdk", name: "AI SDK", orgId: "org_openai" },
    { id: "prod_remail", slug: "react-email", name: "React Email", orgId: "org_openai" },
  ]);
  await testDb.db.insert(sources).values([
    {
      id: "src_router",
      slug: "router-changelog",
      name: "Router Changelog",
      type: "scrape",
      url: "https://openrouter.ai/changelog",
      orgId: "org_openai",
    },
    {
      id: "src_whisper",
      slug: "whisper",
      name: "Whisper",
      type: "github",
      url: "https://github.com/openai/whisper",
      orgId: "org_openai",
    },
  ]);
});

afterEach(() => {
  testDb.cleanup();
});

/** Slice the `## <heading>` block out of the rendered tool text. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}`);
  if (start === -1) return "";
  const rest = text.slice(start + heading.length + 3);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("MCP search — org word-boundary matching", () => {
  it('drops orgs that only matched "ai" via the .ai TLD', async () => {
    const out = await search(asD1(testDb.db), {
      query: "ai",
      type: ["orgs"],
      include_empty: true,
    });
    const orgs = section(out.result.content[0].text, "Organizations");
    expect(orgs).not.toContain("coderabbit");
    expect(orgs).not.toContain("granola");
    // Camel/word name hits survive.
    expect(orgs).toContain("openai");
    expect(orgs).toContain("xai");
    expect(orgs).toContain("moonshot-ai");
  });

  it("ranks name matches above the category-only match", async () => {
    const out = await search(asD1(testDb.db), {
      query: "ai",
      type: ["orgs"],
      include_empty: true,
    });
    const orgs = section(out.result.content[0].text, "Organizations");
    // Anthropic only matches via category "AI"; it must rank after the name hits.
    expect(orgs.indexOf("anthropic")).toBeGreaterThan(orgs.indexOf("xai"));
    expect(orgs.indexOf("moonshot-ai")).toBeLessThan(orgs.indexOf("anthropic"));
  });

  it("matches via a domain-alias label but not its TLD", async () => {
    const out = await search(asD1(testDb.db), {
      query: "claude",
      type: ["orgs"],
      include_empty: true,
    });
    expect(section(out.result.content[0].text, "Organizations")).toContain("anthropic");
  });
});

describe("MCP search — catalog word-boundary matching", () => {
  it("keeps product boundary hits and drops mid-word noise", async () => {
    const out = await search(asD1(testDb.db), { query: "ai", type: ["catalog"] });
    const catalog = section(out.result.content[0].text, "Catalog");
    expect(catalog).toContain("ai-sdk");
    expect(catalog).not.toContain("react-email"); // Em·ai·l
  });

  it("never matches a source via its URL TLD, but matches host/path labels", async () => {
    const tld = await search(asD1(testDb.db), { query: "ai", type: ["catalog"] });
    expect(section(tld.result.content[0].text, "Catalog")).not.toContain("router-changelog");

    const host = await search(asD1(testDb.db), { query: "openrouter", type: ["catalog"] });
    expect(section(host.result.content[0].text, "Catalog")).toContain("router-changelog");

    const path = await search(asD1(testDb.db), { query: "whisper", type: ["catalog"] });
    expect(section(path.result.content[0].text, "Catalog")).toContain("whisper");
  });
});
