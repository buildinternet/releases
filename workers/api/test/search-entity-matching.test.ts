/**
 * Word-boundary entity matching + relevance ordering on the /v1/search entity
 * sections. The query helpers candidate via LIKE %q% in SQL, then post-filter
 * and rank through `rankEntityCandidate` (@releases/lib/entity-match) — so
 * "ai" no longer surfaces every `.ai` domain (CodeRabbit, Granola) or
 * mid-word hits (React Em·ai·l), and exact/prefix matches outrank the old
 * alphabetical ordering. Fixtures mirror the live noise audit.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  organizations,
  products,
  sources,
  releases,
  domainAliases,
} from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper";
import { asD1 } from "../../../tests/mcp-test-helpers";
import { searchOrgs, searchProducts, searchSources } from "../src/queries/search.js";

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
    {
      id: "org_tailwind",
      slug: "tailwind",
      name: "Tailwind CSS",
      domain: "tailwindcss.com",
      category: "Developer Tools",
    },
    { id: "org_resend", slug: "resend", name: "Resend", domain: "resend.com", category: "Email" },
    {
      id: "org_openrouter",
      slug: "openrouter",
      name: "OpenRouter",
      domain: "openrouter.ai",
      category: "AI",
    },
  ]);
  await testDb.db
    .insert(domainAliases)
    .values([{ id: "da_claude", domain: "claude.ai", orgId: "org_anthropic" }]);
  await testDb.db.insert(products).values([
    // "ai" must keep the prefix hit…
    { id: "prod_aisdk", slug: "ai-sdk", name: "AI SDK", orgId: "org_tailwind" },
    // …and drop the mid-word and alias-TLD hits.
    { id: "prod_remail", slug: "react-email", name: "React Email", orgId: "org_resend" },
    { id: "prod_api", slug: "api", name: "API", orgId: "org_openai" },
  ]);
  await testDb.db
    .insert(domainAliases)
    .values([{ id: "da_platform", domain: "platform.openai.com", productId: "prod_api" }]);
  await testDb.db.insert(sources).values([
    {
      id: "src_router",
      slug: "changelog",
      name: "Changelog",
      type: "scrape",
      url: "https://openrouter.ai/changelog",
      orgId: "org_openrouter",
    },
    {
      id: "src_whisper",
      slug: "whisper",
      name: "Whisper",
      type: "github",
      url: "https://github.com/openai/whisper",
      orgId: "org_openai",
    },
    {
      id: "src_aisdk",
      slug: "ai-sdk-releases",
      name: "SDK Releases",
      type: "feed",
      url: "https://sdk.example/releases",
      orgId: "org_tailwind",
      productId: "prod_aisdk",
    },
    {
      id: "src_remail",
      slug: "react-email-releases",
      name: "Email Releases",
      type: "feed",
      url: "https://email.example/releases",
      orgId: "org_resend",
      productId: "prod_remail",
    },
    {
      id: "src_api",
      slug: "api-releases",
      name: "API Releases",
      type: "feed",
      url: "https://platform.example/releases",
      orgId: "org_openai",
      productId: "prod_api",
    },
  ]);
});

const db = () => asD1(testDb.db);

describe("searchOrgs word-boundary matching", () => {
  it('drops orgs that only matched "ai" via the .ai TLD or mid-word', async () => {
    const hits = await searchOrgs(db(), "ai", 20, { includeEmpty: true });
    const slugs = hits.map((h) => h.slug);
    expect(slugs).not.toContain("coderabbit");
    expect(slugs).not.toContain("granola");
  });

  it("ranks name matches above category matches instead of alphabetically", async () => {
    const hits = await searchOrgs(db(), "ai", 20, { includeEmpty: true });
    const slugs = hits.map((h) => h.slug);
    // Camel/word name hits first (alpha within the tier), then category-only.
    expect(slugs.slice(0, 3)).toEqual(["moonshot-ai", "openai", "xai"]);
    // Anthropic only matches via category "AI" — present but ranked after.
    expect(slugs).toContain("anthropic");
    expect(slugs.indexOf("anthropic")).toBeGreaterThan(slugs.indexOf("xai"));
  });

  it("puts an exact name match first regardless of alphabet", async () => {
    const hits = await searchOrgs(db(), "xai", 20, { includeEmpty: true });
    expect(hits[0]?.slug).toBe("xai");
  });

  it("matches via a domain-alias label but not its TLD", async () => {
    const viaAlias = await searchOrgs(db(), "claude", 20, { includeEmpty: true });
    expect(viaAlias.map((h) => h.slug)).toContain("anthropic");
  });

  it("keeps the wire shape free of ranking helper columns", async () => {
    const [hit] = await searchOrgs(db(), "xai", 20, { includeEmpty: true });
    expect(Object.keys(hit).toSorted()).toEqual(
      ["avatarUrl", "category", "domain", "name", "slug"].toSorted(),
    );
  });

  it("still excludes releaseless orgs by default", async () => {
    // Give only OpenAI an indexed release; default opts must hide xAI etc.
    await testDb.db.insert(releases).values({
      id: "rel_1",
      sourceId: "src_whisper",
      title: "Whisper v3",
      content: "x",
      url: "https://github.com/openai/whisper/releases/v3",
      publishedAt: "2026-05-01T00:00:00Z",
    });
    const hits = await searchOrgs(db(), "ai", 20);
    expect(hits.map((h) => h.slug)).toEqual(["openai"]);
  });
});

describe("searchProducts word-boundary matching", () => {
  it("keeps boundary hits and drops mid-word + alias-TLD noise", async () => {
    const hits = await searchProducts(db(), "ai", 20);
    const slugs = hits.map((h) => h.slug);
    expect(slugs).toContain("ai-sdk");
    expect(slugs).not.toContain("react-email"); // Em·ai·l
    expect(slugs).not.toContain("api"); // platform.open·ai·.com alias
  });

  it("matches a product via its alias label", async () => {
    const hits = await searchProducts(db(), "platform", 20);
    expect(hits.map((h) => h.slug)).toContain("api");
  });
});

describe("searchSources word-boundary matching", () => {
  it("never matches a source via its URL TLD", async () => {
    const hits = await searchSources(db(), "ai", 20);
    expect(hits.map((h) => h.slug)).not.toContain("changelog");
  });

  it("matches host labels and path segments at boundaries", async () => {
    const viaHost = await searchSources(db(), "openrouter", 20);
    expect(viaHost.map((h) => h.slug)).toContain("changelog");
    const viaPath = await searchSources(db(), "whisper", 20);
    expect(viaPath.map((h) => h.slug)).toContain("whisper");
  });
});
