import { describe, expect, test } from "bun:test";
import {
  AuthError,
  batchPath,
  idsForUrls,
  postReleaseBatch,
  requireApiToken,
  type FetchLike,
} from "../../actions/publish-changelog/src/client.ts";
import { planChangelogIngest, toBatchBody } from "../../actions/publish-changelog/src/plan.ts";
import { publishChangelog } from "../../actions/publish-changelog/src/publish.ts";

const datedBefore = "# Changelog\n\n## June 9, 2026\n\n**Added**\n- A";
const datedAfter =
  "# Changelog\n\n## June 10, 2026\n\n**Added**\n- NEW\n\n## June 9, 2026\n\n**Added**\n- A EDITED";

const urlTemplate = "https://example.com/updates/{date}";

describe("auth fail-closed", () => {
  test("requireApiToken throws AuthError when the token is missing", () => {
    expect(() => requireApiToken(undefined)).toThrow(AuthError);
    expect(() => requireApiToken("   ")).toThrow(AuthError);
    try {
      requireApiToken("");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(401);
    }
  });

  test("publishChangelog fails closed before any network call when the token is missing", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("fetch must not run");
    };
    await expect(
      publishChangelog({ RELEASES_SOURCE: "src_test", RELEASES_API_TOKEN: "" }, fetchImpl),
    ).rejects.toBeInstanceOf(AuthError);
  });

  test("postReleaseBatch fails closed on 401", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: "invalid token" } }),
    });
    try {
      await postReleaseBatch(fetchImpl, {
        apiUrl: "https://api.example",
        token: "relk_nope",
        source: "src_abc",
        releases: [{ title: "x", content: "y", url: "https://example.com/x" }],
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(401);
      expect((err as AuthError).message).toContain("invalid token");
    }
  });

  test("postReleaseBatch fails closed on 403", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: { message: "write scope required" } }),
    });
    await expect(
      postReleaseBatch(fetchImpl, {
        apiUrl: "https://api.example",
        token: "relu_readonly",
        source: "src_abc",
        releases: [{ title: "x", content: "y", url: "https://example.com/x" }],
      }),
    ).rejects.toMatchObject({ name: "AuthError", status: 403 });
  });
});

describe("batch path + mapping", () => {
  test("typed source ids hit the bare batch route", () => {
    expect(batchPath("src_LNrMz-rrFa2OD27mBUfaT")).toBe(
      "/v1/sources/src_LNrMz-rrFa2OD27mBUfaT/releases/batch",
    );
  });

  test("org + slug hits the org-scoped batch route", () => {
    expect(batchPath("changelog", "acme")).toBe("/v1/orgs/acme/sources/changelog/releases/batch");
  });

  test("postReleaseBatch sends upsert-content and the planned releases", async () => {
    const plan = planChangelogIngest(datedBefore, datedAfter, { urlTemplate });
    let captured: { url?: string; body?: unknown } = {};
    const fetchImpl: FetchLike = async (input, init) => {
      captured = { url: input, body: init?.body ? JSON.parse(init.body) : undefined };
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ inserted: 2, total: 2, insertedIds: ["rel_a", "rel_b"] }),
      };
    };
    const result = await postReleaseBatch(fetchImpl, {
      apiUrl: "https://api.example",
      token: "relk_ok",
      source: "src_abc",
      releases: toBatchBody(plan.releases),
    });
    expect(captured.url).toBe("https://api.example/v1/sources/src_abc/releases/batch");
    expect(captured.body).toEqual({
      mode: "upsert-content",
      releases: toBatchBody(plan.releases),
    });
    expect(result).toEqual({ inserted: 2, total: 2, insertedIds: ["rel_a", "rel_b"] });
  });

  test("idsForUrls matches planned URLs to listed rows", () => {
    expect(
      idsForUrls(
        [
          { id: "rel_new", url: "https://example.com/updates/2026-06-10", publishedAt: null },
          { id: "rel_old", url: "https://example.com/updates/2026-06-09", publishedAt: null },
        ],
        ["https://example.com/updates/2026-06-10"],
      ),
    ).toEqual(["rel_new"]);
  });
});
