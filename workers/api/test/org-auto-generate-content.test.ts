import { describe, it, expect } from "bun:test";
import { organizations } from "@buildinternet/releases-core/schema";
import { orgRoutes } from "../src/routes/orgs.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, orgRoutes);

async function seed(db: ReturnType<typeof mkDb>) {
  await db
    .insert(organizations)
    .values([{ id: "org_acme", slug: "acme", name: "Acme", discovery: "curated" }]);
}

describe("PATCH /v1/orgs/:slug — autoGenerateContent", () => {
  it("persists autoGenerateContent and the GET detail reflects it", async () => {
    const db = mkDb();
    await seed(db);
    const app = mkApp(db);

    // Defaults false before the toggle.
    const before = await app(new Request("https://x.test/v1/orgs/acme"));
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as {
      autoGenerateContent?: boolean;
      discovery?: string;
      fetchPaused?: boolean;
    };
    expect(beforeBody.autoGenerateContent).toBe(false);
    expect(beforeBody.discovery).toBe("curated");
    expect(beforeBody.fetchPaused).toBe(false);

    // Flip it on.
    const patch = await app(
      new Request("https://x.test/v1/orgs/acme", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoGenerateContent: true }),
      }),
    );
    expect(patch.status).toBe(200);

    // GET detail reflects the new value.
    const after = await app(new Request("https://x.test/v1/orgs/acme"));
    const afterBody = (await after.json()) as { autoGenerateContent?: boolean };
    expect(afterBody.autoGenerateContent).toBe(true);
  });

  it("preserves autoGenerateContent when a PATCH omits the field", async () => {
    const db = mkDb();
    await seed(db);
    const app = mkApp(db);

    // Enable it.
    await app(
      new Request("https://x.test/v1/orgs/acme", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoGenerateContent: true }),
      }),
    );

    // PATCH a different field, omitting autoGenerateContent.
    const patch = await app(
      new Request("https://x.test/v1/orgs/acme", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Updated" }),
      }),
    );
    expect(patch.status).toBe(200);

    const after = await app(new Request("https://x.test/v1/orgs/acme"));
    const afterBody = (await after.json()) as { autoGenerateContent?: boolean };
    expect(afterBody.autoGenerateContent).toBe(true);
  });

  it("toggles autoGenerateContent back off", async () => {
    const db = mkDb();
    await seed(db);
    const app = mkApp(db);

    await app(
      new Request("https://x.test/v1/orgs/acme", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoGenerateContent: true }),
      }),
    );
    const off = await app(
      new Request("https://x.test/v1/orgs/acme", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoGenerateContent: false }),
      }),
    );
    expect(off.status).toBe(200);

    const after = await app(new Request("https://x.test/v1/orgs/acme"));
    const afterBody = (await after.json()) as { autoGenerateContent?: boolean };
    expect(afterBody.autoGenerateContent).toBe(false);
  });
});
