import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { publishChangelog } from "../../actions/publish-changelog/src/publish.ts";
import type { FetchLike } from "../../actions/publish-changelog/src/client.ts";

let repoDir: string | undefined;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "publish-changelog-mdx-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  mkdirSync(join(dir, "changelog"), { recursive: true });
  return dir;
}

function write(dir: string, relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function commit(dir: string, message: string): string {
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", message], dir);
  return git(["rev-parse", "HEAD"], dir).trim();
}

afterEach(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  repoDir = undefined;
});

const fetchImpl: (captured: { body?: unknown }[]) => FetchLike =
  (captured) => async (_url, init) => {
    captured.push({ body: init?.body ? JSON.parse(init.body) : undefined });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ inserted: 1, total: 1, insertedIds: ["rel_x"] }),
    };
  };

describe("publishChangelog — directory mode (git integration)", () => {
  test("rejects changelog-glob combined with a non-default changelog-path", async () => {
    repoDir = initRepo();
    await expect(
      publishChangelog(
        {
          RELEASES_API_TOKEN: "relk_x",
          RELEASES_SOURCE: "src_test",
          CHANGELOG_GLOB: "changelog/**/*.mdx",
          CHANGELOG_PATH: "docs/CHANGES.md",
          WORKING_DIRECTORY: repoDir,
        },
        (async () => {
          throw new Error("must not fetch");
        }) as FetchLike,
      ),
    ).rejects.toThrow(/cannot be combined/);
  });

  test("first push (no before-sha) publishes every file matching the glob", async () => {
    repoDir = initRepo();
    write(
      repoDir,
      "changelog/2026-06-01.mdx",
      "---\ntitle: First\ndate: 2026-06-01\n---\n\nFirst body.\n",
    );
    write(
      repoDir,
      "changelog/2026-06-02.mdx",
      "---\ntitle: Second\nslug: second-entry\ndate: 2026-06-02\n---\n\nSecond body.\n",
    );
    commit(repoDir, "initial");

    const captured: { body?: unknown }[] = [];
    const result = await publishChangelog(
      {
        RELEASES_API_TOKEN: "relk_x",
        RELEASES_SOURCE: "src_test",
        CHANGELOG_GLOB: "changelog/**/*.mdx",
        URL_TEMPLATE: "https://example.com/changelog/{slug}",
        WORKING_DIRECTORY: repoDir,
        GENERATE_CONTENT: "false",
        BEFORE_SHA: "0000000000000000000000000000000000000000",
      },
      fetchImpl(captured),
    );

    expect(result.added.sort()).toEqual(["2026-06-01", "second-entry"].sort());
    expect(result.modified).toEqual([]);
    expect(result.deleted).toBe(0);
    const body = captured[0]?.body as { releases: { url: string }[] };
    expect(body.releases.map((r) => r.url).sort()).toEqual(
      [
        "https://example.com/changelog/2026-06-01",
        "https://example.com/changelog/second-entry",
      ].sort(),
    );
  });

  test("added/modified/deleted are classified from git diff --name-status between pushes", async () => {
    repoDir = initRepo();
    write(repoDir, "changelog/a.mdx", "---\ntitle: A\ndate: 2026-06-01\n---\n\nA body.\n");
    write(repoDir, "changelog/b.mdx", "---\ntitle: B\ndate: 2026-06-02\n---\n\nB body.\n");
    const before = commit(repoDir, "first push");

    // Modify a.mdx, delete b.mdx, add c.mdx.
    write(repoDir, "changelog/a.mdx", "---\ntitle: A\ndate: 2026-06-01\n---\n\nA body EDITED.\n");
    execFileSync("git", ["rm", "-q", "changelog/b.mdx"], { cwd: repoDir });
    write(repoDir, "changelog/c.mdx", "---\ntitle: C\ndate: 2026-06-03\n---\n\nC body.\n");
    commit(repoDir, "second push");

    const captured: { body?: unknown }[] = [];
    const result = await publishChangelog(
      {
        RELEASES_API_TOKEN: "relk_x",
        RELEASES_SOURCE: "src_test",
        CHANGELOG_GLOB: "changelog/**/*.mdx",
        URL_TEMPLATE: "https://example.com/changelog/{slug}",
        WORKING_DIRECTORY: repoDir,
        GENERATE_CONTENT: "false",
        BEFORE_SHA: before,
      },
      fetchImpl(captured),
    );

    expect(result.added).toEqual(["c"]);
    expect(result.modified).toEqual(["a"]);
    expect(result.deleted).toBe(1);
    const body = captured[0]?.body as { releases: { url: string; content: string }[] };
    expect(body.releases).toHaveLength(2);
    expect(body.releases.find((r) => r.url.endsWith("/a"))?.content).toContain("EDITED");
  });

  test("re-running the same commit twice is a no-op (same key/url both times)", async () => {
    repoDir = initRepo();
    write(repoDir, "changelog/a.mdx", "---\ntitle: A\ndate: 2026-06-01\n---\n\nA body.\n");
    const before = commit(repoDir, "first push");
    write(repoDir, "changelog/a.mdx", "---\ntitle: A\ndate: 2026-06-01\n---\n\nA body EDITED.\n");
    commit(repoDir, "second push");

    const opts = (fetchC: FetchLike) => ({
      RELEASES_API_TOKEN: "relk_x",
      RELEASES_SOURCE: "src_test",
      CHANGELOG_GLOB: "changelog/**/*.mdx",
      URL_TEMPLATE: "https://example.com/changelog/{slug}",
      WORKING_DIRECTORY: repoDir!,
      GENERATE_CONTENT: "false",
      BEFORE_SHA: before,
    });

    const firstCaptured: { body?: unknown }[] = [];
    const first = await publishChangelog(opts(fetchImpl(firstCaptured)), fetchImpl(firstCaptured));
    const secondCaptured: { body?: unknown }[] = [];
    const second = await publishChangelog(
      opts(fetchImpl(secondCaptured)),
      fetchImpl(secondCaptured),
    );

    const firstUrls = (firstCaptured[0]?.body as { releases: { url: string }[] }).releases.map(
      (r) => r.url,
    );
    const secondUrls = (secondCaptured[0]?.body as { releases: { url: string }[] }).releases.map(
      (r) => r.url,
    );
    expect(firstUrls).toEqual(secondUrls);
    expect(first.added).toEqual(second.added);
    expect(first.modified).toEqual(second.modified);
  });
});
