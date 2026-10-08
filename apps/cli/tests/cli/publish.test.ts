/**
 * `releases publish --dry-run` against the Action's changelog fixtures.
 * Part of buildinternet/releases#2377.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { runCli } from "../utils.js";

const FIXTURES = resolve(import.meta.dir, "../fixtures/publish");
const URL = "https://github.com/acme/site/blob/main/{path}";

const datedBefore = "# Changelog\n\n## June 9, 2026\n\n**Added**\n- A\n";
const datedAfter =
  "# Changelog\n\n## June 10, 2026\n\n**Added**\n- NEW\n\n## June 9, 2026\n\n**Added**\n- A EDITED\n";

function noToken(extra?: Record<string, string>): Record<string, string> {
  return { RELEASES_API_TOKEN: "", GITHUB_REPOSITORY: "", ...extra };
}

describe("releases publish", () => {
  it("documents flags and RELEASES_API_TOKEN in help", () => {
    const { stdout, exitCode } = runCli(["publish", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--dry-run");
    expect(stdout).toContain("--since");
    expect(stdout).toContain("--glob");
    expect(stdout).toContain("--changelog");
    expect(stdout).toContain("RELEASES_API_TOKEN");
    expect(stdout).toContain("upsert-content");
  });

  it("prints the planned batch body for a single changelog without a token", () => {
    const dir = mkdtempSync(join(tmpdir(), "releases-publish-"));
    try {
      writeFileSync(join(dir, "CHANGELOG.md"), datedAfter);
      const { stdout, stderr, exitCode } = runCli(
        [
          "publish",
          "--source",
          "src_test",
          "--cwd",
          dir,
          "--url-template",
          "https://example.com/updates/{date}",
          "--dry-run",
          "--json",
        ],
        { env: noToken() },
      );
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("fetch");
      const body = JSON.parse(stdout) as {
        dryRun: boolean;
        mode: string;
        path: string;
        format: string;
        added: string[];
        modified: string[];
        releases: { title: string; url: string; type: string; publishedAt: string }[];
      };
      expect(body.dryRun).toBe(true);
      expect(body.mode).toBe("upsert-content");
      expect(body.path).toBe("/v1/sources/src_test/releases/batch");
      expect(body.format).toBe("date-sectioned");
      expect(body.added).toEqual(["2026-06-10", "2026-06-09"]);
      expect(body.modified).toEqual([]);
      expect(body.releases.map((r) => r.url)).toEqual([
        "https://example.com/updates/2026-06-10",
        "https://example.com/updates/2026-06-09",
      ]);
      expect(body.releases[0]).toMatchObject({
        title: "June 10, 2026",
        publishedAt: "2026-06-10T12:00:00Z",
        type: "rollup",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("limits the plan to changes since a git commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "releases-publish-git-"));
    try {
      execFileSync("git", ["init"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Dev"], { cwd: dir });
      execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
      writeFileSync(join(dir, "CHANGELOG.md"), datedBefore);
      execFileSync("git", ["add", "CHANGELOG.md"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      writeFileSync(join(dir, "CHANGELOG.md"), datedAfter);
      execFileSync("git", ["add", "CHANGELOG.md"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "edit"], { cwd: dir });

      const { stdout, exitCode } = runCli(
        [
          "publish",
          "--source",
          "acme/docs",
          "--cwd",
          dir,
          "--since",
          sha,
          "--url-template",
          "https://example.com/updates/{date}",
          "--dry-run",
          "--json",
        ],
        { env: noToken() },
      );
      expect(exitCode).toBe(0);
      const body = JSON.parse(stdout) as {
        path: string;
        added: string[];
        modified: string[];
        releases: { content: string; url: string }[];
      };
      expect(body.path).toBe("/v1/orgs/acme/sources/docs/releases/batch");
      expect(body.added).toEqual(["2026-06-10"]);
      expect(body.modified).toEqual(["2026-06-09"]);
      expect(body.releases.map((r) => r.url)).toEqual([
        "https://example.com/updates/2026-06-10",
        "https://example.com/updates/2026-06-09",
      ]);
      expect(body.releases[1]?.content).toContain("A EDITED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diffs --since against the changelog under --cwd, not the repo root", () => {
    const dir = mkdtempSync(join(tmpdir(), "releases-publish-subdir-"));
    const docs = join(dir, "docs");
    const rootBefore = "# Changelog\n\n## June 1, 2026\n\n**Added**\n- ROOT\n";
    try {
      execFileSync("git", ["init"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Dev"], { cwd: dir });
      execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
      writeFileSync(join(dir, "CHANGELOG.md"), rootBefore);
      execFileSync("git", ["add", "CHANGELOG.md"], { cwd: dir });
      mkdirSync(docs, { recursive: true });
      writeFileSync(join(docs, "CHANGELOG.md"), datedBefore);
      execFileSync("git", ["add", "docs/CHANGELOG.md"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      writeFileSync(join(docs, "CHANGELOG.md"), datedAfter);
      execFileSync("git", ["add", "docs/CHANGELOG.md"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "edit docs"], { cwd: dir });

      const { stdout, exitCode } = runCli(
        [
          "publish",
          "--source",
          "src_test",
          "--cwd",
          docs,
          "--since",
          sha,
          "--url-template",
          "https://example.com/updates/{date}",
          "--dry-run",
          "--json",
        ],
        { env: noToken() },
      );
      expect(exitCode).toBe(0);
      const body = JSON.parse(stdout) as { added: string[]; modified: string[] };
      expect(body.added).toEqual(["2026-06-10"]);
      expect(body.modified).toEqual(["2026-06-09"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a --since value that is not a commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "releases-publish-bad-since-"));
    try {
      execFileSync("git", ["init"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Dev"], { cwd: dir });
      execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
      writeFileSync(join(dir, "CHANGELOG.md"), datedAfter);
      execFileSync("git", ["add", "CHANGELOG.md"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir });

      const { stderr, exitCode } = runCli(
        [
          "publish",
          "--source",
          "src_test",
          "--cwd",
          dir,
          "--since",
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "--url-template",
          "https://example.com/updates/{date}",
          "--dry-run",
        ],
        { env: noToken() },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("--since");
      expect(stderr).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes every entry for an all-zero --since without requiring that commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "releases-publish-zero-since-"));
    try {
      execFileSync("git", ["init"], { cwd: dir });
      writeFileSync(join(dir, "CHANGELOG.md"), datedAfter);
      const { stdout, exitCode } = runCli(
        [
          "publish",
          "--source",
          "src_test",
          "--cwd",
          dir,
          "--since",
          "0000000000000000000000000000000000000000",
          "--url-template",
          "https://example.com/updates/{date}",
          "--dry-run",
          "--json",
        ],
        { env: noToken() },
      );
      expect(exitCode).toBe(0);
      const body = JSON.parse(stdout) as { added: string[] };
      expect(body.added).toEqual(["2026-06-10", "2026-06-09"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a changelog added after a real commit as all new", () => {
    const dir = mkdtempSync(join(tmpdir(), "releases-publish-new-file-"));
    try {
      execFileSync("git", ["init"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Dev"], { cwd: dir });
      execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
      writeFileSync(join(dir, "README.md"), "hi\n");
      execFileSync("git", ["add", "README.md"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      writeFileSync(join(dir, "CHANGELOG.md"), datedAfter);

      const { stdout, exitCode } = runCli(
        [
          "publish",
          "--source",
          "src_test",
          "--cwd",
          dir,
          "--since",
          sha,
          "--url-template",
          "https://example.com/updates/{date}",
          "--dry-run",
          "--json",
        ],
        { env: noToken() },
      );
      expect(exitCode).toBe(0);
      const body = JSON.parse(stdout) as { added: string[]; modified: string[] };
      expect(body.added).toEqual(["2026-06-10", "2026-06-09"]);
      expect(body.modified).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plans directory fixtures the same way as the Action", () => {
    const { stdout, exitCode } = runCli(
      [
        "publish",
        "--source",
        "src_test",
        "--cwd",
        join(FIXTURES, "mintlify"),
        "--glob",
        "changelog/**/*.mdx",
        "--url-template",
        URL,
        "--dry-run",
        "--json",
      ],
      { env: noToken() },
    );
    expect(exitCode).toBe(0);
    const body = JSON.parse(stdout) as {
      format: null;
      added: string[];
      deleted: string[];
      releases: {
        title: string;
        content: string;
        url: string;
        publishedAt: string;
        key?: string;
      }[];
    };
    expect(body.format).toBeNull();
    expect(body.added).toEqual(["2026-06-01"]);
    expect(body.deleted).toEqual([]);
    expect(body.releases).toHaveLength(1);
    const release = body.releases[0]!;
    expect(release.title).toBe("New JSON export");
    expect(release.publishedAt).toBe("2026-06-01T12:00:00Z");
    expect(release.url).toBe("https://github.com/acme/site/blob/main/changelog/2026-06-01.mdx");
    expect(release.content).toContain("We added a JSON export option.");
    expect(release.content).toContain("Available on all plans.");
    expect(release.content).not.toContain("import ");
    expect(release.content).not.toContain("<Update");
    expect(release).not.toHaveProperty("key");
  });

  it("fails closed without RELEASES_API_TOKEN on a real publish", () => {
    const { stdout, exitCode } = runCli(["publish", "--source", "src_test", "--json"], {
      env: noToken({ RELEASES_API_KEY: "relu_readonly" }),
    });
    expect(exitCode).toBe(1);
    const body = JSON.parse(stdout) as { error: { kind: string; message: string } };
    expect(body.error.kind).toBe("error");
    expect(body.error.message).toContain("RELEASES_API_TOKEN");
  });

  it("rejects a bare slug that has no org", () => {
    const { stderr, exitCode } = runCli(
      [
        "publish",
        "--source",
        "changelog",
        "--dry-run",
        "--url-template",
        "https://example.com/{key}",
      ],
      { env: noToken() },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--org");
  });

  it("rejects --glob combined with a non-default --changelog", () => {
    const { stderr, exitCode } = runCli(
      [
        "publish",
        "--source",
        "src_test",
        "--glob",
        "changelog/**/*.mdx",
        "--changelog",
        "docs/CHANGELOG.md",
        "--dry-run",
        "--url-template",
        "https://example.com/{key}",
      ],
      { env: noToken() },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--glob");
  });
});
