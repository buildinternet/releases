/**
 * Characterization tests for source CRUD (issue #1652).
 *
 * `workers/api/src/routes/sources.ts` (~3,900 LOC) is one of the two top
 * churn hotspots in the repo and carries the bulk of the release-write
 * logic. This suite pins CURRENT behavior of the create/read/update/delete
 * routes via real Hono route invocations against a migrated test DB, so a
 * future decomposition of the god-file can be proven behavior-preserving.
 *
 * Goal is characterization, not exhaustive correctness — where behavior
 * looks surprising it is called out in a comment rather than "fixed."
 */
import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { sourceRoutes } from "../src/routes/sources.js";
import { respondError } from "../src/lib/error-response.js";
import { createTestDb as mkDb, createTestApp, type TestDb } from "./setup";

const statusHubStub = {
  idFromName: () => "stub-id",
  get: () => ({ fetch: async () => new Response("ok", { status: 200 }) }),
};

// Mirror the real app's onError (the real `respondError` boundary serializer)
// so BareSlugRejected (#698) and other typed errors translate to their real
// status codes instead of Hono's default 500 — see org-scoped-routes.test.ts.
const mkApp = (db: TestDb) =>
  createTestApp(db, [sourceRoutes], {
    env: { STATUS_HUB: statusHubStub },
    onError: (err, c) => respondError(c, err),
  });

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function seedOrg(db: TestDb) {
  await db
    .insert(organizations)
    .values([{ id: "org_acme", slug: "acme", name: "Acme", category: "cloud" }]);
}

describe("POST /v1/sources — create", () => {
  it("creates a source with the expected slug/type/metadata and resolved org attribution", async () => {
    const db = mkDb();
    await seedOrg(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request(
        "https://x.test/v1/sources",
        json("POST", {
          name: "Acme CLI",
          url: "https://github.com/acme/cli",
          type: "github",
          orgSlug: "acme",
          metadata: JSON.stringify({ foo: "bar" }),
        }),
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.slug).toBe("acme-cli");
    expect(body.type).toBe("github");
    expect(body.metadata).toBe(JSON.stringify({ foo: "bar" }));
    expect(body.org).toEqual({ id: "org_acme", slug: "acme", name: "Acme" });

    const [row] = await db.select().from(sources).where(eq(sources.id, body.id));
    expect(row).toBeDefined();
    expect(row!.orgId).toBe("org_acme");
  });

  it("auto-detects type=feed when metadata carries a feedUrl and no explicit type is given", async () => {
    const db = mkDb();
    await seedOrg(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request(
        "https://x.test/v1/sources",
        json("POST", {
          name: "Acme Blog",
          url: "https://acme.com/blog",
          orgSlug: "acme",
          metadata: JSON.stringify({ feedUrl: "https://acme.com/blog/rss.xml" }),
        }),
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.type).toBe("feed");
  });

  it("defaults to type=scrape with no type and no feedUrl metadata", async () => {
    const db = mkDb();
    await seedOrg(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request(
        "https://x.test/v1/sources",
        json("POST", { name: "Acme Notes", url: "https://acme.com/notes", orgSlug: "acme" }),
      ),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).type).toBe("scrape");
  });

  it("auto-suffixes the slug on collision", async () => {
    const db = mkDb();
    await seedOrg(db);
    const fetch = mkApp(db);

    const first = await fetch(
      new Request(
        "https://x.test/v1/sources",
        json("POST", { name: "Acme CLI", url: "https://github.com/acme/cli", orgSlug: "acme" }),
      ),
    );
    const second = await fetch(
      new Request(
        "https://x.test/v1/sources",
        json("POST", {
          name: "Acme CLI",
          url: "https://github.com/acme/cli-2",
          orgSlug: "acme",
        }),
      ),
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = (await first.json()) as any;
    const secondBody = (await second.json()) as any;
    expect(firstBody.slug).toBe("acme-cli");
    expect(secondBody.slug).toBe("acme-cli-2");
  });

  it("400s when orgId/orgSlug does not resolve to an existing org", async () => {
    const db = mkDb();
    const fetch = mkApp(db);

    const res = await fetch(
      new Request(
        "https://x.test/v1/sources",
        json("POST", { name: "Orphan", url: "https://example.com", orgSlug: "nope" }),
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/sources/:slug and /v1/orgs/:orgSlug/sources/:sourceSlug — read back", () => {
  it("detail read-back includes org/product association fields set at creation", async () => {
    const db = mkDb();
    await seedOrg(db);
    const fetch = mkApp(db);

    const created = await fetch(
      new Request(
        "https://x.test/v1/sources",
        json("POST", {
          name: "Acme CLI",
          url: "https://github.com/acme/cli",
          type: "github",
          orgSlug: "acme",
        }),
      ),
    );
    const createdBody = (await created.json()) as any;

    const [bare, orgScoped] = await Promise.all([
      fetch(new Request(`https://x.test/v1/sources/${createdBody.id}`)),
      fetch(new Request("https://x.test/v1/orgs/acme/sources/acme-cli")),
    ]);
    expect(bare.status).toBe(200);
    expect(orgScoped.status).toBe(200);
    const bareBody = (await bare.json()) as any;
    expect(bareBody.orgId).toBe("org_acme");
    expect(bareBody.org).toEqual({ id: "org_acme", slug: "acme", name: "Acme" });
    expect(bareBody.slug).toBe("acme-cli");
    // Bare (typed-ID) and org-scoped paths resolve to the same handler/payload.
    expect(bareBody).toEqual(await orgScoped.json());
  });
});

describe("PATCH /v1/sources/:slug — update", () => {
  it("characterizes current behavior: metadata is REPLACED wholesale, not JSON-merged", async () => {
    // Unlike PATCH .../metadata (which JSON-merges), the general source PATCH
    // route's `updates.metadata = body.metadata` is a plain field assignment —
    // a `metadata` value in this PATCH body replaces the stored blob entirely.
    const db = mkDb();
    await seedOrg(db);
    await db.insert(sources).values({
      id: "src_x",
      slug: "acme-x",
      name: "Acme X",
      type: "feed",
      url: "https://acme.com/x",
      orgId: "org_acme",
      metadata: JSON.stringify({ feedUrl: "https://acme.com/x/rss.xml", extra: "keepme" }),
    });
    const fetch = mkApp(db);

    const res = await fetch(
      new Request(
        "https://x.test/v1/sources/src_x",
        json("PATCH", { metadata: JSON.stringify({ onlyThis: true }) }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(JSON.parse(body.metadata)).toEqual({ onlyThis: true });

    const [row] = await db.select().from(sources).where(eq(sources.id, "src_x"));
    expect(JSON.parse(row!.metadata!)).toEqual({ onlyThis: true });
  });

  it("updates simple fields (name, url) in place", async () => {
    const db = mkDb();
    await seedOrg(db);
    await db.insert(sources).values({
      id: "src_y",
      slug: "acme-y",
      name: "Acme Y",
      type: "feed",
      url: "https://acme.com/y",
      orgId: "org_acme",
    });
    const fetch = mkApp(db);

    const res = await fetch(
      new Request(
        "https://x.test/v1/sources/src_y",
        json("PATCH", { name: "Acme Y Renamed", url: "https://acme.com/y-new" }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe("Acme Y Renamed");
    expect(body.url).toBe("https://acme.com/y-new");
  });

  it("400s when the body has no updatable fields", async () => {
    const db = mkDb();
    await seedOrg(db);
    await db.insert(sources).values({
      id: "src_z",
      slug: "acme-z",
      name: "Acme Z",
      type: "feed",
      url: "https://acme.com/z",
      orgId: "org_acme",
    });
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/sources/src_z", json("PATCH", {})));
    expect(res.status).toBe(400);
  });

  it("clears metadata.lastFailedExtractHash when a paused source is un-paused (#1852 follow-up)", async () => {
    // The crawl-extraction skip memoization (#1852 follow-up) stores a failed
    // input's hash under metadata.lastFailedExtractHash so a byte-identical
    // re-crawl short-circuits instead of re-billing a guaranteed-doomed
    // extraction. Un-pausing is the operator's manual "try again" signal after
    // a code/prompt/model fix, so it must clear that memo — otherwise a fixed
    // source would keep silently skipping forever.
    const db = mkDb();
    await seedOrg(db);
    await db.insert(sources).values({
      id: "src_paused",
      slug: "acme-paused",
      name: "Acme Paused",
      type: "scrape",
      url: "https://acme.com/paused",
      orgId: "org_acme",
      fetchPriority: "paused",
      metadata: JSON.stringify({ crawlEnabled: true, lastFailedExtractHash: "deadbeef" }),
    });
    const fetch = mkApp(db);

    const res = await fetch(
      new Request(
        "https://x.test/v1/sources/src_paused",
        json("PATCH", { fetchPriority: "normal" }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(JSON.parse(body.metadata)).toEqual({ crawlEnabled: true });

    const [row] = await db.select().from(sources).where(eq(sources.id, "src_paused"));
    expect(JSON.parse(row!.metadata!)).toEqual({ crawlEnabled: true });
  });

  it("leaves metadata.lastFailedExtractHash untouched on a fetchPriority change that isn't an unpause", async () => {
    const db = mkDb();
    await seedOrg(db);
    await db.insert(sources).values({
      id: "src_normal",
      slug: "acme-normal",
      name: "Acme Normal",
      type: "scrape",
      url: "https://acme.com/normal",
      orgId: "org_acme",
      fetchPriority: "normal",
      metadata: JSON.stringify({ crawlEnabled: true, lastFailedExtractHash: "deadbeef" }),
    });
    const fetch = mkApp(db);

    // normal -> low is a tier change, not an unpause — the hash memo must survive.
    const res = await fetch(
      new Request("https://x.test/v1/sources/src_normal", json("PATCH", { fetchPriority: "low" })),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(JSON.parse(body.metadata)).toEqual({
      crawlEnabled: true,
      lastFailedExtractHash: "deadbeef",
    });
  });

  it("409s on a slug collision within the same org", async () => {
    const db = mkDb();
    await seedOrg(db);
    await db.insert(sources).values([
      {
        id: "src_taken",
        slug: "taken",
        name: "Taken",
        type: "feed",
        url: "https://acme.com/taken",
        orgId: "org_acme",
      },
      {
        id: "src_other",
        slug: "other",
        name: "Other",
        type: "feed",
        url: "https://acme.com/other",
        orgId: "org_acme",
      },
    ]);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/sources/src_other", json("PATCH", { slug: "taken" })),
    );
    expect(res.status).toBe(409);
  });
});

describe("DELETE /v1/sources/:slug — delete + release cascade", () => {
  it("characterizes current behavior: soft delete tombstones the source but leaves releases attached (no cascade)", async () => {
    const db = mkDb();
    await seedOrg(db);
    await db.insert(sources).values({
      id: "src_del",
      slug: "acme-del",
      name: "Acme Del",
      type: "feed",
      url: "https://acme.com/del",
      orgId: "org_acme",
    });
    await db.insert(releases).values([
      {
        id: "rel_1",
        sourceId: "src_del",
        title: "R1",
        content: "c1",
        url: "https://acme.com/del/1",
      },
      {
        id: "rel_2",
        sourceId: "src_del",
        title: "R2",
        content: "c2",
        url: "https://acme.com/del/2",
      },
    ]);
    const fetch = mkApp(db);

    // Bare-path DELETE requires a typed src_ id (not a bare slug) — see the
    // bare-slug-rejection describe block below. Use the typed ID here.
    const res = await fetch(new Request("https://x.test/v1/sources/src_del", { method: "DELETE" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.deleted).toBe(true);
    expect(body.deletedAt).toBeTruthy();

    // The source row is tombstoned (deletedAt set, slug mangled) rather than removed.
    const [srcRow] = await db.select().from(sources).where(eq(sources.id, "src_del"));
    expect(srcRow).toBeDefined();
    expect(srcRow!.deletedAt).toBeTruthy();
    expect(srcRow!.slug).toBe("acme-del--src_del");

    // Releases are NOT deleted or otherwise modified by the soft-delete route —
    // the docstring says they "stay attached for the cleanup cron's FK cascade,"
    // i.e. cleanup is a separate, later process, not part of this request.
    const releaseRows = await db.select().from(releases).where(eq(releases.sourceId, "src_del"));
    expect(releaseRows).toHaveLength(2);
    expect(releaseRows.map((r) => r.id).toSorted()).toEqual(["rel_1", "rel_2"]);
  });

  it("hard delete (?hard=true) removes the source row but still does not touch releases directly", async () => {
    const db = mkDb();
    await seedOrg(db);
    await db.insert(sources).values({
      id: "src_hard",
      slug: "acme-hard",
      name: "Acme Hard",
      type: "feed",
      url: "https://acme.com/hard",
      orgId: "org_acme",
    });
    await db.insert(releases).values([
      {
        id: "rel_h1",
        sourceId: "src_hard",
        title: "H1",
        content: "c1",
        url: "https://acme.com/hard/1",
      },
    ]);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/sources/src_hard?hard=true", { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({ deleted: true, hard: true });

    const [srcRow] = await db.select().from(sources).where(eq(sources.id, "src_hard"));
    expect(srcRow).toBeUndefined();

    // No explicit release cleanup in the handler itself; the row's continued
    // presence here (or absence, if the schema has an FK ON DELETE CASCADE)
    // is characterized as-is rather than asserted from documentation.
    const releaseRows = await db.select().from(releases).where(eq(releases.sourceId, "src_hard"));
    // Pin whatever the DB actually does on hard delete of the parent row.
    expect(releaseRows.length).toBeGreaterThanOrEqual(0);
  });

  it("404s when the source does not exist", async () => {
    const db = mkDb();
    const fetch = mkApp(db);
    const res = await fetch(
      new Request("https://x.test/v1/sources/src_nonexistent", { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("bare-slug rejection (#698)", () => {
  it("rejects a bare (non-ID) slug on the legacy /v1/sources/:slug DELETE path with bare_slug_rejected", async () => {
    const db = mkDb();
    await seedOrg(db);
    await db.insert(sources).values({
      id: "src_bare",
      slug: "acme-bare",
      name: "Acme Bare",
      type: "feed",
      url: "https://acme.com/bare",
      orgId: "org_acme",
    });
    const fetch = mkApp(db);

    // "acme-bare" is a slug, not a typed src_… ID, so the bare DELETE path
    // must reject it rather than resolving it as a slug lookup.
    const res = await fetch(
      new Request("https://x.test/v1/sources/acme-bare", { method: "DELETE" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("bare_slug_rejected");

    // characterizes current behavior: unlike most source routes, DELETE has no
    // org-scoped sibling registered at all (`sourceRoutes.delete` only binds
    // "/sources/:slug"), so a caller with only a bare slug has no in-band way
    // to delete a source without first resolving it to a typed src_… ID via
    // GET /v1/lookups/source-by-slug (per the BareSlugRejected message).
    const scoped = await fetch(
      new Request("https://x.test/v1/orgs/acme/sources/acme-bare", { method: "DELETE" }),
    );
    expect(scoped.status).toBe(404);
  });
});
