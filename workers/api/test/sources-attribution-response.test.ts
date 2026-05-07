/**
 * `POST /v1/sources`, `PATCH /v1/sources/:slug`, `GET /v1/sources/:slug` —
 * resolved attribution in the response.
 *
 * Pre-#794 the create / update endpoints returned the bare drizzle row, so
 * agents had to round-trip a follow-up GET to confirm `productSlug` and
 * resolve org metadata. The shape now carries `org { id, slug, name }`,
 * `productId`, and `productSlug` directly.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, products } from "@buildinternet/releases-core/schema";
import { Hono } from "hono";
import { sourceRoutes } from "../src/routes/sources.js";

const statusHubStub = {
  idFromName: () => "stub-id",
  get: () => ({ fetch: async () => new Response("ok", { status: 200 }) }),
};

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function mkApp(db: ReturnType<typeof mkDb>) {
  const fakeEnv = { DB: db, STATUS_HUB: statusHubStub };
  const fakeCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", sourceRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv, fakeCtx);
}

async function seed(db: ReturnType<typeof mkDb>) {
  await db.insert(organizations).values({
    id: "org_google",
    slug: "google",
    name: "Google",
    category: "cloud",
  });
  await db.insert(products).values({
    id: "prod_chrome",
    orgId: "org_google",
    slug: "chrome",
    name: "Chrome",
  });
}

describe("source attribution in mutation responses", () => {
  it("POST returns org block + productSlug when productSlug is supplied", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Chrome Releases",
          url: "https://chromereleases.googleblog.com/",
          orgSlug: "google",
          productSlug: "chrome",
        }),
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.orgId).toBe("org_google");
    expect(body.productId).toBe("prod_chrome");
    expect(body.productSlug).toBe("chrome");
    expect(body.org).toEqual({ id: "org_google", slug: "google", name: "Google" });
  });

  it("POST resolves productId directly when supplied", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Chrome Status",
          url: "https://chromestatus.com/",
          orgSlug: "google",
          productId: "prod_chrome",
        }),
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.productId).toBe("prod_chrome");
    expect(body.productSlug).toBe("chrome");
  });

  it("POST rejects unknown productSlug with 400", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Workspace Updates",
          url: "https://workspaceupdates.googleblog.com/",
          orgSlug: "google",
          productSlug: "does-not-exist",
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("bad_request");
  });

  it("POST without product returns null product fields and resolved org block", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Google Blog",
          url: "https://blog.google/",
          orgSlug: "google",
        }),
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.productId).toBeNull();
    expect(body.productSlug).toBeNull();
    expect(body.org).toEqual({ id: "org_google", slug: "google", name: "Google" });
  });

  it("PATCH returns enriched response after updating productId", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const createRes = await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Some Source",
          url: "https://example.test/changelog",
          orgSlug: "google",
        }),
      }),
    );
    const created = (await createRes.json()) as { slug: string };

    const patchRes = await fetch(
      new Request(`https://x.test/v1/orgs/google/sources/${created.slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: "prod_chrome" }),
      }),
    );

    expect(patchRes.status).toBe(200);
    const body = (await patchRes.json()) as Record<string, unknown>;
    expect(body.productId).toBe("prod_chrome");
    expect(body.productSlug).toBe("chrome");
    expect(body.org).toEqual({ id: "org_google", slug: "google", name: "Google" });
  });

  it("GET source detail returns org id + productSlug top-level", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Chrome Releases",
          url: "https://chromereleases.googleblog.com/",
          orgSlug: "google",
          productSlug: "chrome",
        }),
      }),
    );

    const res = await fetch(new Request("https://x.test/v1/orgs/google/sources/chrome-releases"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.productId).toBe("prod_chrome");
    expect(body.productSlug).toBe("chrome");
    expect(body.org).toMatchObject({ id: "org_google", slug: "google", name: "Google" });
  });
});
