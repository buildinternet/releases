import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources, sourceRawSnapshots } from "@buildinternet/releases-core/schema";
import { createTestDb, createTestApp, type TestDb } from "./setup";
import { sourceRoutes } from "../src/routes/sources";

function fakeR2() {
  const store = new Map<string, string>();
  return {
    store,
    put: async (k: string, v: ArrayBuffer | string) => {
      store.set(k, typeof v === "string" ? v : new TextDecoder().decode(v));
    },
    get: async (k: string) => (store.has(k) ? { text: async () => store.get(k)! } : null),
    head: async (k: string) => (store.has(k) ? {} : null),
  };
}

const ORG = "org_raw";
const SRC = "src_raw";
const PATH = `/v1/orgs/${ORG}/sources/${SRC}/raw-snapshot`;

async function seed(db: TestDb) {
  await db
    .insert(organizations)
    .values({ id: ORG, slug: "acme", name: "Acme", category: "developer-tools" });
  await db.insert(sources).values({
    id: SRC,
    orgId: ORG,
    slug: "acme-blog",
    name: "Acme Blog",
    type: "scrape",
    url: "https://acme.test/changelog",
  });
}

describe("POST /orgs/:org/sources/:src/raw-snapshot (#1283)", () => {
  let db: TestDb;
  let R2: ReturnType<typeof fakeR2>;
  let fetchApi: (req: Request) => Response | Promise<Response>;

  beforeEach(async () => {
    db = createTestDb();
    await seed(db);
    R2 = fakeR2();
    fetchApi = createTestApp(db, sourceRoutes, { env: { RAW_SNAPSHOTS: R2 } });
  });

  const post = (body: unknown, path = PATH) =>
    fetchApi(
      new Request(`https://api${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("stores the body to R2 + a pointer row and returns stored:true", async () => {
    const res = await post({ body: "# v1\nhello", format: "markdown" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.stored).toBe(true);
    expect(json.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(json.r2Key).toBe(`sources/${SRC}/raw/${json.contentHash as string}.md`);
    expect(R2.store.get(json.r2Key as string)).toBe("# v1\nhello");

    const rows = await db
      .select()
      .from(sourceRawSnapshots)
      .where(eq(sourceRawSnapshots.sourceId, SRC));
    expect(rows).toHaveLength(1);
  });

  it("dedups by content hash: same body twice → stored:false, exactly one row", async () => {
    await post({ body: "same body" });
    const res = await post({ body: "same body" });
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.stored).toBe(false);

    const rows = await db
      .select()
      .from(sourceRawSnapshots)
      .where(eq(sourceRawSnapshots.sourceId, SRC));
    expect(rows).toHaveLength(1);
  });

  it("defaults format to markdown when omitted", async () => {
    const res = await post({ body: "x" });
    const json = (await res.json()) as Record<string, unknown>;
    expect((json.r2Key as string).endsWith(".md")).toBe(true);
  });

  it("400 on empty or missing body", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ body: "   " })).status).toBe(400);
  });

  it("400 on an unsupported format", async () => {
    expect((await post({ body: "x", format: "pdf" })).status).toBe(400);
  });

  it("404 when the source is not found", async () => {
    const res = await post({ body: "x" }, `/v1/orgs/${ORG}/sources/src_missing/raw-snapshot`);
    expect(res.status).toBe(404);
  });

  it("soft-fails with stored:false when RAW_SNAPSHOTS is unbound", async () => {
    const noR2 = createTestApp(db, sourceRoutes, { env: {} });
    const res = await noR2(
      new Request(`https://api${PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "x" }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.stored).toBe(false);
    expect(json.reason).toBe("no_binding");
  });
});
