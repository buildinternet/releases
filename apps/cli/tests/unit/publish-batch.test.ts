/**
 * Auth and batch POST for `releases publish`. Part of buildinternet/releases#2377.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { ApiError } from "../../src/lib/errors.js";
import {
  postReleaseBatch,
  requirePublishToken,
  resolvePublishTarget,
} from "../../src/cli/commands/publish.js";

describe("resolvePublishTarget", () => {
  test("typed source ids hit the bare batch route", () => {
    expect(resolvePublishTarget("src_LNrMz-rrFa2OD27mBUfaT").path).toBe(
      "/v1/sources/src_LNrMz-rrFa2OD27mBUfaT/releases/batch",
    );
  });

  test("org + slug hits the org-scoped batch route", () => {
    expect(resolvePublishTarget("changelog", "acme").path).toBe(
      "/v1/orgs/acme/sources/changelog/releases/batch",
    );
  });

  test("org/slug coordinate is split locally", () => {
    expect(resolvePublishTarget("acme/changelog")).toEqual({
      source: "changelog",
      org: "acme",
      path: "/v1/orgs/acme/sources/changelog/releases/batch",
    });
  });

  test("a bare slug without --org fails before any request", () => {
    expect(() => resolvePublishTarget("changelog")).toThrow(/--org/);
  });
});

describe("requirePublishToken", () => {
  test("fails closed when RELEASES_API_TOKEN is missing, even if an API key is set", () => {
    expect(() =>
      requirePublishToken({ RELEASES_API_KEY: "relu_readonly", RELEASES_API_TOKEN: "  " }),
    ).toThrow(/RELEASES_API_TOKEN/);
    expect(() => requirePublishToken({ RELEASES_API_KEY: "relu_readonly" })).toThrow(
      /RELEASES_API_TOKEN/,
    );
  });

  test("returns the trimmed publish token", () => {
    expect(requirePublishToken({ RELEASES_API_TOKEN: "  relk_ok  " })).toBe("relk_ok");
  });
});

describe("postReleaseBatch", () => {
  let originalFetch: typeof globalThis.fetch;
  const prev: { url?: string; key?: string } = {};

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    prev.url = process.env.RELEASES_API_URL;
    prev.key = process.env.RELEASES_API_KEY;
    process.env.RELEASES_API_URL = "https://api.example";
    process.env.RELEASES_API_KEY = "relu_should_not_be_sent";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (prev.url === undefined) delete process.env.RELEASES_API_URL;
    else process.env.RELEASES_API_URL = prev.url;
    if (prev.key === undefined) delete process.env.RELEASES_API_KEY;
    else process.env.RELEASES_API_KEY = prev.key;
  });

  test("sends upsert-content with the publish token, not RELEASES_API_KEY", async () => {
    let captured: { url?: string; headers?: Headers; body?: unknown } = {};
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      captured = {
        url: String(input),
        headers,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      return new Response(
        JSON.stringify({ inserted: 2, total: 2, insertedIds: ["rel_a", "rel_b"] }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    const releases = [
      {
        title: "June 10, 2026",
        content: "**Added**\n- NEW",
        url: "https://example.com/updates/2026-06-10",
        publishedAt: "2026-06-10T12:00:00Z",
        version: null,
        type: "rollup" as const,
        prerelease: false,
      },
    ];
    const result = await postReleaseBatch(
      "/v1/sources/src_abc/releases/batch",
      releases,
      "relk_ok",
    );
    expect(captured.url).toBe("https://api.example/v1/sources/src_abc/releases/batch");
    expect(captured.headers?.get("authorization")).toBe("Bearer relk_ok");
    expect(captured.headers?.get("authorization")).not.toContain("relu_should_not_be_sent");
    expect(captured.headers?.get("idempotency-key")).toBeTruthy();
    expect(captured.body).toEqual({ mode: "upsert-content", releases });
    expect(result).toEqual({ inserted: 2, total: 2, insertedIds: ["rel_a", "rel_b"] });
  });

  test("fails closed on 401", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: "unauthorized", type: "auth", message: "invalid token" } }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      )) as typeof fetch;
    await expect(
      postReleaseBatch(
        "/v1/sources/src_abc/releases/batch",
        [{ title: "x", content: "y", url: "https://example.com/x", type: "feature" }],
        "relk_nope",
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
