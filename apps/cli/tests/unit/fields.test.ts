import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import {
  parseFieldsFlag,
  projectFields,
  unmatchedFields,
  applyFieldMask,
} from "../../src/lib/fields.js";
import { logger } from "@buildinternet/releases-lib/logger";

describe("parseFieldsFlag", () => {
  it("splits, trims, and dedupes", () => {
    expect(parseFieldsFlag(" id, version ,id, source.slug ")).toEqual([
      "id",
      "version",
      "source.slug",
    ]);
  });
  it("drops empties", () => {
    expect(parseFieldsFlag("id,,, ,version")).toEqual(["id", "version"]);
  });
});

describe("projectFields", () => {
  const obj = {
    id: "rel_1",
    version: "1.2.0",
    title: "T",
    source: { slug: "acme", name: "Acme" },
    media: [{ url: "https://x/a.png" }],
  };

  it("projects top-level fields, dropping the rest", () => {
    const { projected } = projectFields(obj, ["id", "version"]);
    expect(projected).toEqual({ id: "rel_1", version: "1.2.0" });
  });

  it("projects nested fields via dot-notation and merges siblings under one parent", () => {
    const { projected } = projectFields(obj, ["id", "source.slug", "source.name"]);
    expect(projected).toEqual({ id: "rel_1", source: { slug: "acme", name: "Acme" } });
  });

  it("returns an array-valued field whole", () => {
    const { projected } = projectFields(obj, ["media"]);
    expect(projected).toEqual({ media: [{ url: "https://x/a.png" }] });
  });

  it("does not index into arrays via dot-notation (skips the field)", () => {
    const { projected, matched } = projectFields(obj, ["media.url"]);
    expect(projected).toEqual({});
    expect(matched.has("media.url")).toBe(false);
  });

  it("maps over an array of objects", () => {
    const { projected } = projectFields([obj, { ...obj, id: "rel_2" }], ["id"]);
    expect(projected).toEqual([{ id: "rel_1" }, { id: "rel_2" }]);
  });

  it("tracks unmatched fields (typos surface, no throw)", () => {
    const { matched } = projectFields(obj, ["id", "nope", "source.bogus"]);
    expect(unmatchedFields(["id", "nope", "source.bogus"], matched)).toEqual([
      "nope",
      "source.bogus",
    ]);
  });

  it("passes a scalar through untouched", () => {
    expect(projectFields(null, ["id"]).projected).toBeNull();
  });
});

describe("applyFieldMask", () => {
  it("returns the value unchanged when no mask is set", () => {
    const v = { id: "x", title: "y" };
    expect(applyFieldMask(v, undefined)).toBe(v);
  });
  it("projects when a mask is set", () => {
    expect(applyFieldMask({ id: "x", title: "y" }, "id")).toEqual({ id: "x" });
  });
});

// Integration: the mask reaches the writeJson output of `get` on a release.
describe("get --fields integration", () => {
  const prevEnv: { url?: string; key?: string } = {};
  beforeAll(() => {
    prevEnv.url = process.env.RELEASES_API_URL;
    prevEnv.key = process.env.RELEASES_API_KEY;
    process.env.RELEASES_API_URL = "https://test.example.com";
    process.env.RELEASES_API_KEY = "test-key";
  });
  afterAll(() => {
    if (prevEnv.url === undefined) delete process.env.RELEASES_API_URL;
    else process.env.RELEASES_API_URL = prevEnv.url;
    if (prevEnv.key === undefined) delete process.env.RELEASES_API_KEY;
    else process.env.RELEASES_API_KEY = prevEnv.key;
  });

  let originalFetch: typeof globalThis.fetch;
  let originalWrite: typeof process.stdout.write;
  let out: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWrite = process.stdout.write;
    out = "";
    process.stdout.write = ((chunk: unknown) => {
      out += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/v1/releases/rel_x")) {
        return new Response(
          JSON.stringify({
            id: "rel_x",
            version: "2.0.0",
            title: "Big release",
            content: "## notes\nlots of body",
            sourceSlug: "acme-changelog",
            sourceName: "Acme Changelog",
            org: { slug: "acme", name: "Acme" },
            publishedAt: "2026-06-01T00:00:00Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("null", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  });

  it("projects the slim release shape down to the requested fields", async () => {
    const { getEntityAction } = await import("../../src/cli/commands/get.js");
    await getEntityAction("rel_x", { json: true, fields: "id,version,source.slug" });
    expect(JSON.parse(out)).toEqual({
      id: "rel_x",
      version: "2.0.0",
      source: { slug: "acme-changelog" },
    });
  });

  // The `--fields`-without-`--json` warning lives in getEntityAction, before
  // routing, so it fires for every entity kind — not just the release branch.
  it("warns about --fields without --json on a non-release path", async () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    try {
      const { getEntityAction } = await import("../../src/cli/commands/get.js");
      // "vercel" routes through the org/product/source resolvers (all 404 here)
      // → notFound → process.exit; the warning must already have fired upstream.
      await expect(getEntityAction("vercel", { fields: "id" })).rejects.toThrow(/process\.exit/);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("--fields only affects"))).toBe(
        true,
      );
    } finally {
      warnSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
