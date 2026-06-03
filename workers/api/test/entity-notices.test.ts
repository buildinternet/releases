import { describe, it, expect } from "bun:test";
import { organizations, products } from "@buildinternet/releases-core/schema";
import { orgRoutes } from "../src/routes/orgs.js";
import { productRoutes } from "../src/routes/products.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const patch = (body: unknown) => ({
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("org notice", () => {
  it("sets, exposes, preserves other metadata, and clears", async () => {
    const db = mkDb();
    await db.insert(organizations).values([
      {
        id: "org_ws",
        slug: "windsurf",
        name: "Windsurf",
        discovery: "curated",
        metadata: JSON.stringify({ feedUrl: "https://x" }),
      },
    ]);
    const app = createTestApp(db, orgRoutes);

    // set
    const set = await app(
      new Request(
        "https://x.test/v1/orgs/windsurf",
        patch({
          notice: {
            message: "Windsurf is now Cognition's Devin.",
            coordinate: "cognition/devin",
            linkText: "View Devin",
          },
        }),
      ),
    );
    expect(set.status).toBe(200);

    // detail exposes typed notice, raw metadata key preserved
    const detail = await app(new Request("https://x.test/v1/orgs/windsurf"));
    const body = (await detail.json()) as { notice?: { message: string; coordinate?: string } };
    expect(body.notice?.message).toBe("Windsurf is now Cognition's Devin.");
    expect(body.notice?.coordinate).toBe("cognition/devin");

    // clear
    const cleared = await app(
      new Request("https://x.test/v1/orgs/windsurf", patch({ notice: null })),
    );
    expect(cleared.status).toBe(200);
    const after = await app(new Request("https://x.test/v1/orgs/windsurf"));
    const afterBody = (await after.json()) as { notice?: unknown };
    expect(afterBody.notice ?? null).toBeNull();
  });
});

describe("product notice", () => {
  it("sets and exposes a notice on product detail without leaking raw metadata", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values([{ id: "org_cog", slug: "cognition", name: "Cognition", discovery: "curated" }]);
    await db
      .insert(products)
      .values([{ id: "prd_devin", slug: "devin", name: "Devin", orgId: "org_cog" }]);
    const app = createTestApp(db, productRoutes);

    const set = await app(
      new Request(
        "https://x.test/v1/orgs/cognition/products/devin",
        patch({
          notice: { message: "Formerly Windsurf.", coordinate: "windsurf" },
        }),
      ),
    );
    expect(set.status).toBe(200);

    const detail = await app(new Request("https://x.test/v1/orgs/cognition/products/devin"));
    const body = (await detail.json()) as {
      notice?: { message: string; coordinate?: string };
      metadata?: unknown;
    };
    expect(body.notice?.message).toBe("Formerly Windsurf.");
    expect(body.notice?.coordinate).toBe("windsurf");
    expect("metadata" in body).toBe(false); // raw metadata blob is not surfaced on products
  });
});
