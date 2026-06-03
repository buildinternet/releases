/**
 * The "Featured in" sidebar surfaces at both the org and product levels:
 *
 * - `GET /v1/orgs/:slug/collections` lists collections the org belongs to
 *   *either* directly (org member) *or* via one of its products (the
 *   "coding agents" → Claude Code case from the original ticket). Deduped.
 * - `GET /v1/products/:slug/collections` (+ the org-scoped twin) lists the
 *   collections that pin the product.
 *
 * Both join visible members through organizations_public / products_active so
 * soft-deleted products never leak a phantom collection onto the org page.
 */
import { describe, it, expect } from "bun:test";
import {
  organizations,
  products,
  collections,
  collectionMembers,
} from "@buildinternet/releases-core/schema";
import { orgRoutes } from "../src/routes/orgs.js";
import { productRoutes } from "../src/routes/products.js";
import { BareSlugRejected } from "../src/utils.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) =>
  createTestApp(db, [orgRoutes, productRoutes], {
    // Mirror the real app's onError so a bare product slug (#698) maps to 400
    // instead of surfacing as Hono's default 500.
    onError: (err, c) => {
      if (err instanceof BareSlugRejected) {
        return c.json(
          { error: "bare_slug_rejected", entity: err.entity, message: err.message },
          400,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "internal", message }, 500);
    },
  });

async function seed(db: ReturnType<typeof mkDb>) {
  await db.insert(organizations).values([
    { id: "org_anth", slug: "anthropic", name: "Anthropic", category: "ai" },
    { id: "org_oai", slug: "openai", name: "OpenAI", category: "ai" },
  ]);
  await db.insert(products).values([
    { id: "prod_cc", orgId: "org_anth", slug: "claude-code", name: "Claude Code" },
    { id: "prod_msg", orgId: "org_anth", slug: "messages", name: "Messages API" },
    // Soft-deleted: products_active excludes it, so a collection that only pins
    // this product must NOT surface on the org page.
    {
      id: "prod_gone",
      orgId: "org_anth",
      slug: "old-tool",
      name: "Old Tool",
      deletedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  // `test-`-prefixed slugs so the seed migration's `frontier-ai-labs` row
  // doesn't collide with these fixtures. Names drive the ORDER BY.
  await db.insert(collections).values([
    { id: "col_coding", slug: "test-coding-agents", name: "Coding Agents" },
    { id: "col_frontier", slug: "test-frontier", name: "Frontier Labs" },
    { id: "col_mixed", slug: "test-mixed", name: "Mixed Set" },
    { id: "col_openai", slug: "test-openai", name: "OpenAI Only" },
    { id: "col_ghost", slug: "test-ghost", name: "Ghost Set" },
  ]);
  await db.insert(collectionMembers).values([
    // Reached only via the product.
    { collectionId: "col_coding", productId: "prod_cc", position: 0 },
    // Reached only via the org itself.
    { collectionId: "col_frontier", orgId: "org_anth", position: 0 },
    // Reached via BOTH — must list once on the org page.
    { collectionId: "col_mixed", orgId: "org_anth", position: 0 },
    { collectionId: "col_mixed", productId: "prod_cc", position: 1 },
    // A different org — must not surface for anthropic.
    { collectionId: "col_openai", orgId: "org_oai", position: 0 },
    // Only a soft-deleted product — must not surface for anthropic.
    { collectionId: "col_ghost", productId: "prod_gone", position: 0 },
  ]);
}

const ours = <T extends { slug: string }>(body: T[]) =>
  body.filter((c) => c.slug.startsWith("test-"));

describe("org collections sidebar (org + product membership)", () => {
  it("merges direct org membership with product membership, deduped and name-ordered", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/orgs/anthropic/collections"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      slug: string;
      name: string;
      description: string | null;
      isFeatured: boolean;
      memberCount: number;
    }>;
    // This exact-array assertion covers every invariant at once:
    //   - membership: Coding Agents (product-only), Frontier Labs (org-only),
    //     Mixed Set (both) — all three surface.
    //   - dedup: Mixed Set pins the org AND its product yet appears once.
    //   - exclusion: OpenAI Only (another org) and Ghost Set (only a
    //     soft-deleted product) are absent.
    //   - ordering: alphabetical by name.
    expect(ours(body)).toEqual([
      {
        slug: "test-coding-agents",
        name: "Coding Agents",
        description: null,
        isFeatured: false,
        memberCount: 1,
      },
      {
        slug: "test-frontier",
        name: "Frontier Labs",
        description: null,
        isFeatured: false,
        memberCount: 1,
      },
      {
        slug: "test-mixed",
        name: "Mixed Set",
        description: null,
        isFeatured: false,
        memberCount: 2,
      },
    ]);
  });

  it("404s on an unknown org", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/orgs/nope/collections"));
    expect(res.status).toBe(404);
  });
});

describe("product collections sidebar", () => {
  it("returns the collections that pin the product, name-ordered (org-scoped path)", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request("http://test/v1/orgs/anthropic/products/claude-code/collections"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ slug: string; memberCount: number }>;
    expect(body.map((c) => c.slug)).toEqual(["test-coding-agents", "test-mixed"]);
    // memberCount mirrors the org/collection endpoints: orgs + products.
    expect(body.find((c) => c.slug === "test-mixed")!.memberCount).toBe(2);
  });

  it("returns the same set via the typed-id bare path", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/products/prod_cc/collections"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ slug: string }>;
    expect(body.map((c) => c.slug)).toEqual(["test-coding-agents", "test-mixed"]);
  });

  it("returns an empty list for a product in no collections", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request("http://test/v1/orgs/anthropic/products/messages/collections"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toEqual([]);
  });

  it("rejects a bare product slug with 400 (#698)", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/products/claude-code/collections"));
    expect(res.status).toBe(400);
  });

  it("404s on an unknown product", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/orgs/anthropic/products/nope/collections"));
    expect(res.status).toBe(404);
  });
});
