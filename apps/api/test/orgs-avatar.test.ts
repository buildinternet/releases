import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations } from "@buildinternet/releases-core/schema";
import { createTestDb, createTestApp, type TestDb } from "./setup";
import { orgRoutes } from "../src/routes/orgs";
import { restoreGlobalFetch } from "../../../tests/global-fetch";

function pngBytes(w: number, h: number): Uint8Array {
  const header = [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52,
    (w >>> 24) & 0xff,
    (w >>> 16) & 0xff,
    (w >>> 8) & 0xff,
    w & 0xff,
    (h >>> 24) & 0xff,
    (h >>> 16) & 0xff,
    (h >>> 8) & 0xff,
    h & 0xff,
    0x08,
    0x06,
    0x00,
    0x00,
    0x00,
  ];
  const buf = new Uint8Array(2048);
  buf.set(header, 0);
  return buf;
}

function fakeR2() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    put: async (k: string, v: ArrayBuffer | Uint8Array) => {
      store.set(k, v instanceof Uint8Array ? v : new Uint8Array(v));
    },
  };
}

// Point the global fetch at fixed image bytes (the route uses the global fetch; no
// injection seam). Restored in afterEach.
const stubFetch = (bytes: Uint8Array, contentType = "image/png") => {
  globalThis.fetch = (async () =>
    new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": contentType },
    })) as unknown as typeof fetch;
};

describe("POST /orgs/:slug/avatar (#1406)", () => {
  let db: TestDb;
  let R2: ReturnType<typeof fakeR2>;
  let fetchApi: (req: Request) => Response | Promise<Response>;

  beforeEach(async () => {
    db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_a", slug: "acme", name: "Acme", category: "developer-tools" });
    R2 = fakeR2();
    fetchApi = createTestApp(db, orgRoutes, {
      env: { MEDIA: R2, MEDIA_ORIGIN: "https://media.test" },
    });
  });
  afterEach(() => {
    restoreGlobalFetch();
  });

  const post = (slug: string, body: unknown) =>
    fetchApi(
      new Request(`https://api/v1/orgs/${slug}/avatar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("404 when the org is missing (before any fetch)", async () => {
    const res = await post("nope", { sourceUrl: "https://cdn.test/i.png" });
    expect(res.status).toBe(404);
  });

  it("mirrors the image, sets avatarUrl, returns 200", async () => {
    stubFetch(pngBytes(256, 256));
    const res = await post("acme", { sourceUrl: "https://cdn.test/icon.png" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.avatarUrl).toBe("https://media.test/orgs/acme.png");
    expect(json.width).toBe(256);
    expect(R2.store.has("orgs/acme.png")).toBe(true);

    const [org] = await db.select().from(organizations).where(eq(organizations.id, "org_a"));
    expect(org!.avatarUrl).toBe("https://media.test/orgs/acme.png");
  });

  it("rejects a non-square image (validation), leaving avatarUrl unchanged", async () => {
    stubFetch(pngBytes(400, 150));
    const res = await post("acme", { sourceUrl: "https://cdn.test/wide.png" });
    // #1830 item 2: the off-map 422 folds to `validation` (400); the specific
    // reject reason survives in the nested envelope's `details.reason`.
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; type: string; details?: { reason?: string } };
    };
    expect(body.error.type).toBe("validation");
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details?.reason).toBe("not_square");

    const [org] = await db.select().from(organizations).where(eq(organizations.id, "org_a"));
    expect(org!.avatarUrl ?? null).toBeNull();
    expect(R2.store.size).toBe(0);
  });

  it("400 on an invalid sourceUrl (schema validation)", async () => {
    const res = await post("acme", { sourceUrl: "not-a-url" });
    expect(res.status).toBe(400);
  });
});
