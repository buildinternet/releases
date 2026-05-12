/**
 * Validator-middleware coverage for POST /v1/orgs/:slug/overview — the
 * routes/overview.ts handler now reads `c.req.valid("json")` instead of
 * hand-parsing the body. Asserts schema-rejection paths return the
 * `{ error: "bad_request", message }` envelope; cross-field
 * `endIndex <= content.length` still returns `bad_citations`.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { applyMigrations } from "../db-helper";
import { organizations } from "@buildinternet/releases-core/schema";
import overview from "../../workers/api/src/routes/overview";

function mkDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

function mkApp(db: ReturnType<typeof mkDb>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).set("db", db);
    await next();
  });
  app.route("/", overview);
  return app;
}

describe("POST /v1/orgs/:slug/overview (validateJson)", () => {
  let db: ReturnType<typeof mkDb>;
  let app: ReturnType<typeof mkApp>;

  beforeEach(async () => {
    db = mkDb();
    app = mkApp(db);
    await db.insert(organizations).values({ name: "Acme", slug: "acme" });
  });

  async function post(body: unknown): Promise<Response> {
    return app.request("/orgs/acme/overview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("happy path with no citations upserts the page", async () => {
    const res = await post({
      content: "hello world",
      releaseCount: 3,
      lastContributingReleaseAt: "2026-05-01T00:00:00.000Z",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: true; citations: number };
    expect(json).toEqual({ ok: true, citations: 0 });
  });

  it("400 bad_request when content is missing", async () => {
    const res = await post({ releaseCount: 0 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message.toLowerCase()).toContain("content");
  });

  it("400 bad_request when content is the empty string (schema min(1))", async () => {
    const res = await post({ content: "", releaseCount: 0 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("400 bad_request when releaseCount is negative", async () => {
    const res = await post({ content: "hi", releaseCount: -1 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("400 bad_request when releaseCount is not an integer", async () => {
    const res = await post({ content: "hi", releaseCount: 1.5 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("400 bad_request when a citation has endIndex <= startIndex (schema refine)", async () => {
    const res = await post({
      content: "hello world",
      releaseCount: 0,
      citations: [
        {
          startIndex: 5,
          endIndex: 5,
          sourceUrl: "https://example.com",
          citedText: "hello",
        },
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("400 bad_request when citation sourceUrl is empty (schema min(1))", async () => {
    const res = await post({
      content: "hello world",
      releaseCount: 0,
      citations: [
        {
          startIndex: 0,
          endIndex: 5,
          sourceUrl: "",
          citedText: "hello",
        },
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("400 bad_citations when endIndex > content.length (handler cross-check)", async () => {
    const res = await post({
      content: "short",
      releaseCount: 0,
      citations: [
        {
          startIndex: 0,
          endIndex: 99,
          sourceUrl: "https://example.com",
          citedText: "short",
        },
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_citations");
    expect(body.message).toContain("past content length");
  });

  it("404 when org doesn't exist", async () => {
    const res = await app.request("/orgs/ghost/overview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi", releaseCount: 0 }),
    });
    expect(res.status).toBe(404);
  });

  it("400 bad_request even when org doesn't exist (validator runs before lookup)", async () => {
    // Locks in the validation-order behavior shift documented in #912: the
    // validator middleware runs before the org lookup, so a malformed body
    // 400s before the handler has a chance to 404 on a missing slug.
    const res = await app.request("/orgs/ghost/overview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ releaseCount: 0 }), // missing content
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });
});
