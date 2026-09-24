import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  globBaseDir,
  keyFromPath,
  planDirectoryIngest,
  renderUrlTemplate,
  toBatchBody,
  type DirectoryFileInput,
} from "../../actions/publish-changelog/src/plan.ts";

const FIXTURES = resolve(import.meta.dir, "fixtures");

function readFixture(relPath: string): string {
  return readFileSync(resolve(FIXTURES, relPath), "utf8");
}

describe("globBaseDir", () => {
  test("static prefix before the first wildcard", () => {
    expect(globBaseDir("changelog/**/*.mdx")).toBe("changelog/");
    expect(globBaseDir("blog/*.mdx")).toBe("blog/");
    expect(globBaseDir("*.mdx")).toBe("");
    expect(globBaseDir("docs/changelog/entries/**/*.md")).toBe("docs/changelog/entries/");
  });
});

describe("keyFromPath", () => {
  test("strips the base dir and the extension", () => {
    expect(keyFromPath("changelog/2026-06-01.mdx", "changelog/")).toBe("2026-06-01");
    expect(keyFromPath("blog/2026-06-03-cool-thing/index.mdx", "blog/")).toBe(
      "2026-06-03-cool-thing/index",
    );
  });
});

describe("renderUrlTemplate — {slug} placeholder", () => {
  test("interpolates slug alongside the existing placeholders", () => {
    expect(
      renderUrlTemplate("https://x/{path}#{slug}", {
        key: "a",
        slug: "a",
        version: "",
        date: "",
        path: "changelog/a.mdx",
      }),
    ).toBe("https://x/changelog/a.mdx#a");
  });
});

const urlTemplate = "https://github.com/acme/site/blob/main/{path}";

describe("planDirectoryIngest — Mintlify-style fixtures", () => {
  test("flattens <Update>/<Callout> and strips the import line", () => {
    const files: DirectoryFileInput[] = [
      {
        path: "changelog/2026-06-01.mdx",
        status: "A",
        content: readFixture("mintlify/changelog/2026-06-01.mdx"),
      },
    ];
    const plan = planDirectoryIngest(files, { urlTemplate, glob: "changelog/**/*.mdx" });
    expect(plan.added).toEqual(["2026-06-01"]);
    expect(plan.modified).toEqual([]);
    expect(plan.deleted).toEqual([]);
    expect(plan.releases).toHaveLength(1);

    const release = plan.releases[0]!;
    expect(release.title).toBe("New JSON export");
    expect(release.publishedAt).toBe("2026-06-01T12:00:00Z");
    expect(release.url).toBe("https://github.com/acme/site/blob/main/changelog/2026-06-01.mdx");
    expect(release.content).not.toContain("import ");
    expect(release.content).not.toContain("<Update");
    expect(release.content).not.toContain("<Callout");
    expect(release.content).toContain("We added a JSON export option.");
    expect(release.content).toContain("Available on all plans.");
  });

  test("skips draft: true files entirely", () => {
    const files: DirectoryFileInput[] = [
      {
        path: "changelog/2026-06-04-draft.mdx",
        status: "A",
        content: readFixture("mintlify/changelog/2026-06-04-draft.mdx"),
      },
    ];
    const plan = planDirectoryIngest(files, { urlTemplate, glob: "changelog/**/*.mdx" });
    expect(plan.added).toEqual([]);
    expect(plan.releases).toEqual([]);
  });
});

describe("planDirectoryIngest — Fumadocs/Docusaurus-style fixtures", () => {
  test("uses frontmatter slug as the key and version from frontmatter", () => {
    const files: DirectoryFileInput[] = [
      {
        path: "changelog/foo.mdx",
        status: "M",
        content: readFixture("fumadocs/changelog/foo.mdx"),
      },
    ];
    const plan = planDirectoryIngest(files, { urlTemplate, glob: "changelog/**/*.mdx" });
    expect(plan.modified).toEqual(["foo-bar-release"]);
    expect(plan.added).toEqual([]);

    const release = plan.releases[0]!;
    expect(release.key).toBe("foo-bar-release");
    expect(release.version).toBe("1.2.0");
    expect(release.publishedAt).toBe("2026-06-02T12:00:00Z");
    expect(release.url).toBe("https://github.com/acme/site/blob/main/changelog/foo.mdx");
  });

  test("fenced code blocks are preserved verbatim", () => {
    const files: DirectoryFileInput[] = [
      {
        path: "changelog/foo.mdx",
        status: "A",
        content: readFixture("fumadocs/changelog/foo.mdx"),
      },
    ];
    const plan = planDirectoryIngest(files, { urlTemplate, glob: "changelog/**/*.mdx" });
    const release = plan.releases[0]!;
    expect(release.content).toContain("```ts");
    expect(release.content).toContain("<Callout>should not flatten</Callout>");
    expect(release.content).not.toContain("<Video");
  });

  test("frontmatter url wins over the url-template", () => {
    const files: DirectoryFileInput[] = [
      {
        path: "blog/2026-06-03-cool-thing/index.mdx",
        status: "A",
        content: readFixture("fumadocs/blog/2026-06-03-cool-thing/index.mdx"),
      },
    ];
    const plan = planDirectoryIngest(files, { urlTemplate, glob: "blog/**/*.mdx" });
    const release = plan.releases[0]!;
    expect(release.key).toBe("cool-thing-shipped");
    expect(release.url).toBe("https://example.com/blog/cool-thing-shipped");
  });
});

describe("planDirectoryIngest — classification and idempotency", () => {
  const added: DirectoryFileInput = {
    path: "changelog/new.mdx",
    status: "A",
    content: "---\ntitle: New\ndate: 2026-06-05\n---\n\nBody A",
  };
  const modified: DirectoryFileInput = {
    path: "changelog/existing.mdx",
    status: "M",
    content: "---\ntitle: Existing\ndate: 2026-06-06\n---\n\nBody B",
  };
  const deletedFile: DirectoryFileInput = { path: "changelog/gone.mdx", status: "D" };

  test("classifies added/modified/deleted separately", () => {
    const plan = planDirectoryIngest([added, modified, deletedFile], {
      urlTemplate,
      glob: "changelog/**/*.mdx",
    });
    expect(plan.added).toEqual(["new"]);
    expect(plan.modified).toEqual(["existing"]);
    expect(plan.deleted).toEqual(["changelog/gone.mdx"]);
    // Deleted files are reported only — never turned into a release row.
    expect(plan.releases.map((r) => r.key)).toEqual(["new", "existing"]);
  });

  test("renames land as a modified entry at the new path", () => {
    const renamed: DirectoryFileInput = {
      path: "changelog/renamed-new.mdx",
      status: "M",
      content: "---\ntitle: Renamed\ndate: 2026-06-07\n---\n\nBody C",
    };
    const plan = planDirectoryIngest([renamed], { urlTemplate, glob: "changelog/**/*.mdx" });
    expect(plan.modified).toEqual(["renamed-new"]);
    expect(plan.added).toEqual([]);
  });

  test("re-running the same input gives an identical batch body (stable key)", () => {
    const first = planDirectoryIngest([added, modified], {
      urlTemplate,
      glob: "changelog/**/*.mdx",
    });
    const replay = planDirectoryIngest([added, modified], {
      urlTemplate,
      glob: "changelog/**/*.mdx",
    });
    expect(toBatchBody(first.releases)).toEqual(toBatchBody(replay.releases));
    expect(first.releases.map((r) => r.url)).toEqual(replay.releases.map((r) => r.url));
  });
});
