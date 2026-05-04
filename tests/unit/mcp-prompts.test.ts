import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { organizations, products } from "@buildinternet/releases-core/schema";
import { newOrgId, newProductId } from "@buildinternet/releases-core/id";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { asD1, createMcpTestClient } from "../mcp-test-helpers.js";
import { registerPrompts } from "../../workers/mcp/src/prompts.js";

const linkPrompts = (db: TestDatabase["db"], aiTools: boolean) =>
  createMcpTestClient(registerPrompts, asD1(db), { aiTools });

async function seed(db: TestDatabase["db"]) {
  const vercel = { id: newOrgId(), name: "Vercel", slug: "vercel" };
  const supabase = { id: newOrgId(), name: "Supabase", slug: "supabase" };
  await db.insert(organizations).values([
    { id: vercel.id, name: vercel.name, slug: vercel.slug },
    { id: supabase.id, name: supabase.name, slug: supabase.slug },
  ]);
  await db.insert(products).values([
    { id: newProductId(), orgId: vercel.id, name: "Next.js", slug: "nextjs" },
    { id: newProductId(), orgId: vercel.id, name: "Next.js Canary", slug: "nextjs-canary" },
    { id: newProductId(), orgId: vercel.id, name: "Turborepo", slug: "turborepo" },
  ]);
}

function firstText(message: { content: { type: string; text?: string } }): string {
  if (message.content.type !== "text" || typeof message.content.text !== "string") {
    throw new Error("expected text content");
  }
  return message.content.text;
}

describe("MCP prompts + completion", () => {
  let fixture: TestDatabase;

  beforeAll(() => {
    fixture = createTestDb();
  });

  afterAll(() => {
    fixture.cleanup();
  });

  beforeEach(async () => {
    clearAllTables(fixture.db);
    await seed(fixture.db);
  });

  it("lists the three priming prompts", async () => {
    const link = await linkPrompts(fixture.db, false);
    try {
      const { prompts } = await link.client.listPrompts();
      const names = prompts.map((p) => p.name).toSorted();
      expect(names).toEqual(["catch_me_up", "compare_products", "whats_new"]);
    } finally {
      await link.close();
    }
  });

  it("whats_new falls back to get_latest_releases when AI tools are off", async () => {
    const link = await linkPrompts(fixture.db, false);
    try {
      const result = await link.client.getPrompt({
        name: "whats_new",
        arguments: { product: "nextjs", days: "14" },
      });
      expect(result.messages).toHaveLength(1);
      const text = firstText(result.messages[0]);
      expect(text).toContain("nextjs");
      expect(text).toContain("14");
      expect(text).toContain("get_latest_releases");
      expect(text).not.toContain("summarize_changes");
    } finally {
      await link.close();
    }
  });

  it("whats_new prefers summarize_changes when AI tools are on", async () => {
    const link = await linkPrompts(fixture.db, true);
    try {
      const result = await link.client.getPrompt({
        name: "whats_new",
        arguments: { product: "nextjs" },
      });
      const text = firstText(result.messages[0]);
      expect(text).toContain("summarize_changes");
      // default window: 30 days
      expect(text).toContain("30");
      // AI branch should not also instruct the LLM to call the fallback tool.
      expect(text).not.toContain("get_latest_releases");
    } finally {
      await link.close();
    }
  });

  it("compare_products names both products in the prompt body", async () => {
    const link = await linkPrompts(fixture.db, true);
    try {
      const result = await link.client.getPrompt({
        name: "compare_products",
        arguments: { productA: "nextjs", productB: "turborepo" },
      });
      const text = firstText(result.messages[0]);
      expect(text).toContain("nextjs");
      expect(text).toContain("turborepo");
      expect(text).toContain("compare_products");
    } finally {
      await link.close();
    }
  });

  it("catch_me_up queues the overview then the recent releases", async () => {
    const link = await linkPrompts(fixture.db, false);
    try {
      const result = await link.client.getPrompt({
        name: "catch_me_up",
        arguments: { organization: "vercel" },
      });
      const text = firstText(result.messages[0]);
      // Overview now rides on get_organization with the include_overview flag.
      expect(text).toContain("get_organization");
      expect(text).toContain("include_overview");
      expect(text).not.toContain("get_organization_overview");
      expect(text).toContain("get_latest_releases");
      expect(text).toContain("vercel");
      expect(text).toContain("14");
    } finally {
      await link.close();
    }
  });

  it("completes product args via ref/prompt", async () => {
    const link = await linkPrompts(fixture.db, true);
    try {
      const result = await link.client.complete({
        ref: { type: "ref/prompt", name: "whats_new" },
        argument: { name: "product", value: "next" },
      });
      const values = result.completion.values.toSorted();
      // Catalog completion returns coordinates so the interpolated tool call lands on
      // an unambiguous product (per-org slug uniqueness, #690).
      expect(values).toEqual(["vercel/nextjs", "vercel/nextjs-canary"]);
    } finally {
      await link.close();
    }
  });

  it("matches prompt arg by substring, not just prefix", async () => {
    // "repo" only appears mid-slug of "turborepo" — prefix-only completion
    // would miss this.
    const link = await linkPrompts(fixture.db, true);
    try {
      const result = await link.client.complete({
        ref: { type: "ref/prompt", name: "whats_new" },
        argument: { name: "product", value: "repo" },
      });
      expect(result.completion.values).toEqual(["vercel/turborepo"]);
    } finally {
      await link.close();
    }
  });

  it("completes organization arg on catch_me_up", async () => {
    const link = await linkPrompts(fixture.db, false);
    try {
      const result = await link.client.complete({
        ref: { type: "ref/prompt", name: "catch_me_up" },
        argument: { name: "organization", value: "sup" },
      });
      expect(result.completion.values).toEqual(["supabase"]);
    } finally {
      await link.close();
    }
  });

  it("interpolates coordinate-form completions into the prompt body unchanged", async () => {
    // Regression: completion previously returned bare slugs that downstream
    // tools (summarize_changes / compare_products / get_latest_releases /
    // get_catalog_entry) reject with `bare_slug_rejected`. Coordinates round-
    // trip cleanly, so the prompt body must preserve them verbatim.
    const link = await linkPrompts(fixture.db, true);
    try {
      const completion = await link.client.complete({
        ref: { type: "ref/prompt", name: "whats_new" },
        argument: { name: "product", value: "next" },
      });
      const [coordinate] = completion.completion.values;
      expect(coordinate).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+$/);

      const prompt = await link.client.getPrompt({
        name: "whats_new",
        arguments: { product: coordinate, days: "7" },
      });
      const text = (prompt.messages[0].content as { text: string }).text;
      expect(text).toContain(coordinate);
    } finally {
      await link.close();
    }
  });
});
