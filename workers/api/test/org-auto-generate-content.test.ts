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
    const enable = await app(
      new Request("https://x.test/v1/orgs/acme", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoGenerateContent: true }),
      }),
    );
    expect(enable.status).toBe(200);

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

    const enable = await app(
      new Request("https://x.test/v1/orgs/acme", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoGenerateContent: true }),
      }),
    );
    expect(enable.status).toBe(200);
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

describe("POST /v1/orgs — autoGenerateContent default (#1795)", () => {
  it("defaults autoGenerateContent=true when omitted (curated onboarding)", async () => {
    const db = mkDb();
    const app = mkApp(db);

    const res = await app(
      new Request("https://x.test/v1/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Widgets Inc" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string; autoGenerateContent?: boolean };
    expect(body.autoGenerateContent).toBe(true);
  });

  it("honors an explicit autoGenerateContent=false opt-out at creation", async () => {
    const db = mkDb();
    const app = mkApp(db);

    const res = await app(
      new Request("https://x.test/v1/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Quiet Co", autoGenerateContent: false }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { autoGenerateContent?: boolean };
    expect(body.autoGenerateContent).toBe(false);
  });
});

async function seedAgent(db: ReturnType<typeof mkDb>) {
  await db.insert(organizations).values([
    {
      id: "org_agent",
      slug: "agentco",
      name: "AgentCo",
      discovery: "agent",
      autoGenerateContent: false,
    },
  ]);
}

describe("PATCH /v1/orgs/:slug — promotion-to-curated default (#1795)", () => {
  it("opts a promoted org into AI content by default", async () => {
    const db = mkDb();
    await seedAgent(db);
    const app = mkApp(db);

    const res = await app(
      new Request("https://x.test/v1/orgs/agentco", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discovery: "curated" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { discovery?: string; autoGenerateContent?: boolean };
    expect(body.discovery).toBe("curated");
    expect(body.autoGenerateContent).toBe(true);
  });

  it("respects an explicit autoGenerateContent=false in the promotion request", async () => {
    const db = mkDb();
    await seedAgent(db);
    const app = mkApp(db);

    const res = await app(
      new Request("https://x.test/v1/orgs/agentco", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discovery: "curated", autoGenerateContent: false }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { autoGenerateContent?: boolean };
    expect(body.autoGenerateContent).toBe(false);
  });

  it("does not re-flip an already-curated org's deliberate opt-out", async () => {
    const db = mkDb();
    await seed(db); // org_acme, discovery: curated, autoGenerateContent defaults false
    const app = mkApp(db);

    // Re-saving a curated org (discovery unchanged) must not silently enable it.
    const res = await app(
      new Request("https://x.test/v1/orgs/acme", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discovery: "curated", description: "Touched" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { autoGenerateContent?: boolean };
    expect(body.autoGenerateContent).toBe(false);
  });
});
