import { describe, expect, test } from "bun:test";
import {
  AuthError,
  batchPath,
  idsForUrls,
  postReleaseBatch,
  requireApiToken,
  type FetchLike,
} from "../../actions/publish-changelog/src/client.ts";
import {
  isUnparsableChangelog,
  planChangelogIngest,
  renderUrlTemplate,
  toBatchBody,
} from "../../actions/publish-changelog/src/plan.ts";
import { publishChangelog } from "../../actions/publish-changelog/src/publish.ts";

const keepAChangelogBefore = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "- wip",
  "",
  "## [1.3.0] - 2026-04-01",
  "",
  "### Changed",
  "- tweaked defaults",
  "",
].join("\n");

const keepAChangelogAfter = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "- wip",
  "",
  "## [1.4.0] - 2026-05-01",
  "",
  "### Added",
  "- new --json flag",
  "",
  "## [1.3.0] - 2026-04-01",
  "",
  "### Changed",
  "- tweaked defaults (hotfix)",
  "",
].join("\n");

const datedBefore = "# Changelog\n\n## June 9, 2026\n\n**Added**\n- A";
const datedAfter =
  "# Changelog\n\n## June 10, 2026\n\n**Added**\n- NEW\n\n## June 9, 2026\n\n**Added**\n- A EDITED";

const urlTemplate = "https://example.com/updates/{date}";

describe("planChangelogIngest — versioned Keep a Changelog", () => {
  test("maps added and modified sections to the /batch release shape", () => {
    const plan = planChangelogIngest(keepAChangelogBefore, keepAChangelogAfter, {
      urlTemplate: "https://github.com/acme/sdk/blob/main/CHANGELOG.md#{key}",
      changelogPath: "CHANGELOG.md",
    });
    expect(plan.format).toBe("keep-a-changelog");
    expect(plan.added).toEqual(["1.4.0"]);
    expect(plan.modified).toEqual(["1.3.0"]);
    expect(plan.releases).toHaveLength(2);

    const added = plan.releases.find((r) => r.key === "1.4.0");
    expect(added).toEqual({
      key: "1.4.0",
      title: "1.4.0",
      content: "### Added\n- new --json flag",
      url: "https://github.com/acme/sdk/blob/main/CHANGELOG.md#1.4.0",
      publishedAt: "2026-05-01T12:00:00Z",
      version: "1.4.0",
      type: "feature",
      prerelease: false,
    });

    const modified = plan.releases.find((r) => r.key === "1.3.0");
    expect(modified?.url).toBe("https://github.com/acme/sdk/blob/main/CHANGELOG.md#1.3.0");
    expect(modified?.content).toContain("hotfix");
  });

  test("keeps a heading permalink instead of the template", () => {
    const conventional = [
      "## [2.0.0](https://github.com/o/r/compare/v1.9.0...v2.0.0) (2026-05-10)",
      "",
      "### Features",
      "- big thing",
      "",
    ].join("\n");
    const plan = planChangelogIngest("", conventional, {
      urlTemplate: "https://unused.example/{key}",
    });
    expect(plan.format).toBe("conventional");
    expect(plan.releases[0]?.url).toBe("https://github.com/o/r/compare/v1.9.0...v2.0.0");
  });
});

describe("planChangelogIngest — date-sectioned (dogfood CHANGELOG.md)", () => {
  test("maps added/modified dates to rollup batch rows", () => {
    const plan = planChangelogIngest(datedBefore, datedAfter, { urlTemplate });
    expect(plan.format).toBe("date-sectioned");
    expect(plan.added).toEqual(["2026-06-10"]);
    expect(plan.modified).toEqual(["2026-06-09"]);
    expect(plan.releases.map((r) => r.url)).toEqual([
      "https://example.com/updates/2026-06-10",
      "https://example.com/updates/2026-06-09",
    ]);
    expect(plan.releases[0]).toMatchObject({
      title: "June 10, 2026",
      publishedAt: "2026-06-10T12:00:00Z",
      type: "rollup",
    });
  });

  test("re-planning the same after snapshot is a no-op (idempotent URLs)", () => {
    const first = planChangelogIngest(datedBefore, datedAfter, { urlTemplate });
    const replay = planChangelogIngest(datedAfter, datedAfter, { urlTemplate });
    expect(replay.added).toEqual([]);
    expect(replay.modified).toEqual([]);
    expect(replay.releases).toEqual([]);
    expect(first.releases.map((r) => r.url)).toEqual([
      "https://example.com/updates/2026-06-10",
      "https://example.com/updates/2026-06-09",
    ]);
  });
});

describe("planChangelogIngest — empty / unparsable", () => {
  test("identical files produce no releases", () => {
    const plan = planChangelogIngest(datedBefore, datedBefore, { urlTemplate });
    expect(plan.releases).toEqual([]);
  });

  test("empty before treats every section as added", () => {
    const plan = planChangelogIngest("", datedBefore, { urlTemplate });
    expect(plan.added).toEqual(["2026-06-09"]);
    expect(plan.modified).toEqual([]);
  });

  test("prose-only markdown is unparsable", () => {
    const md = "# Notes\n\n## Welcome\n\nHello.\n";
    expect(isUnparsableChangelog(md)).toBe(true);
    expect(planChangelogIngest("", md, { urlTemplate }).format).toBe("unknown");
  });
});

describe("renderUrlTemplate", () => {
  test("interpolates key, version, date, and path", () => {
    expect(
      renderUrlTemplate("https://x/{path}#{key}-{version}-{date}", {
        key: "1.0.0",
        version: "1.0.0",
        date: "2026-05-01",
        path: "docs/CHANGELOG.md",
      }),
    ).toBe("https://x/docs/CHANGELOG.md#1.0.0-1.0.0-2026-05-01");
  });
});

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
