import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, orgAccounts, orgTags } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../test/setup.js";
import { syncOrgWellKnown } from "./reconcile-org.js";

function fakeR2() {
  const store = new Map<string, unknown>();
  return {
    store,
    put: async (k: string, v: unknown) => void store.set(k, v),
    get: async (k: string) => store.get(k) ?? null,
  } as any;
}

describe("syncOrgWellKnown", () => {
  it("applies owner fields and records the selfDeclared marker", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_a", slug: "acme", name: "Acme", category: null, description: null });

    const res = await syncOrgWellKnown(db as any, "org_a", {
      bucket: fakeR2(),
      mediaOrigin: "https://media.test",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            description: "CI for teams.",
            tags: ["ci"],
            social: { twitter: "acmehq" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      domain: "acme.com",
    });

    expect(res.applied).toBe(true);
    const [o] = await db.select().from(organizations).where(eq(organizations.id, "org_a"));
    expect(o!.description).toBe("CI for teams.");
    const accts = await db.select().from(orgAccounts).where(eq(orgAccounts.orgId, "org_a"));
    expect(accts.map((a) => a.platform)).toContain("twitter");
    const tgs = await db.select().from(orgTags).where(eq(orgTags.orgId, "org_a"));
    expect(tgs.length).toBe(1);
    expect(JSON.parse(o!.metadata!).selfDeclared.fields).toContain("description");
  });

  it("dryRun returns a plan and writes nothing", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_b", slug: "beta", name: "Beta" });
    const res = await syncOrgWellKnown(db as any, "org_b", {
      bucket: fakeR2(),
      mediaOrigin: "https://media.test",
      domain: "beta.com",
      dryRun: true,
      fetchImpl: async () =>
        new Response(JSON.stringify({ description: "x" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(res.applied).toBe(false);
    expect(res.plan?.columnUpdates.description).toBe("x");
    const [o] = await db.select().from(organizations).where(eq(organizations.id, "org_b"));
    expect(o!.description ?? null).toBeNull();
  });

  it("short-circuits as unchanged when the marker hash matches", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_d", slug: "delta", name: "Delta" });
    const file = { description: "stable copy." };
    const fetchImpl = async () =>
      new Response(JSON.stringify(file), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const first = await syncOrgWellKnown(db as any, "org_d", {
      bucket: fakeR2(),
      mediaOrigin: "https://media.test",
      domain: "delta.com",
      fetchImpl,
    });
    expect(first.applied).toBe(true);
    const second = await syncOrgWellKnown(db as any, "org_d", {
      bucket: fakeR2(),
      mediaOrigin: "https://media.test",
      domain: "delta.com",
      fetchImpl,
    });
    expect(second.applied).toBe(false);
    expect(second.skippedReason).toBe("unchanged");
  });

  it("no-ops when the org has no domain", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_c", slug: "gamma", name: "Gamma" });
    const res = await syncOrgWellKnown(db as any, "org_c", {
      bucket: fakeR2(),
      mediaOrigin: "https://media.test",
      domain: null,
    });
    expect(res.applied).toBe(false);
    expect(res.skippedReason).toBe("no_domain");
  });

  it("rejects a domain with URL-special characters", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_e", slug: "eps", name: "Eps" });
    const res = await syncOrgWellKnown(db as any, "org_e", {
      bucket: fakeR2(),
      mediaOrigin: "https://media.test",
      domain: "evil.com/@169.254.169.254",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    expect(res.applied).toBe(false);
    expect(res.skippedReason).toBe("invalid_domain");
  });
});
