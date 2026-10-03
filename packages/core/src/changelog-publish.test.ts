import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  UPSERT_CONTENT_MODE,
  extractTitleHeading,
  flattenMdxToMarkdown,
  globBaseDir,
  isMissingOrZeroSha,
  isUnparsableChangelog,
  keyFromPath,
  parseFrontmatter,
  planChangelogIngest,
  planDirectoryIngest,
  renderUrlTemplate,
  toBatchBody,
  toBatchRequest,
  type DirectoryFileInput,
} from "./changelog-publish.js";

const FIXTURES = resolve(import.meta.dir, "../fixtures/changelog-publish");

function readFixture(relPath: string): string {
  return readFileSync(resolve(FIXTURES, relPath), "utf8");
}

const keepAChangelogBefore = readFixture("single-file/keep-a-changelog-before.md");
const keepAChangelogAfter = readFixture("single-file/keep-a-changelog-after.md");
const datedBefore = readFixture("single-file/dated-before.md");
const datedAfter = readFixture("single-file/dated-after.md");
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
    const plan = planChangelogIngest("", readFixture("single-file/conventional.md"), {
      urlTemplate: "https://unused.example/{key}",
    });
    expect(plan.format).toBe("conventional");
    expect(plan.releases[0]?.url).toBe("https://github.com/o/r/compare/v1.9.0...v2.0.0");
  });

  test("toBatchRequest is the dry-run upsert-content body", () => {
    const plan = planChangelogIngest(keepAChangelogBefore, keepAChangelogAfter, {
      urlTemplate: "https://github.com/acme/sdk/blob/main/CHANGELOG.md#{key}",
      changelogPath: "CHANGELOG.md",
    });
    expect(toBatchRequest(plan.releases)).toEqual({
      mode: UPSERT_CONTENT_MODE,
      releases: toBatchBody(plan.releases),
    });
    expect(toBatchRequest(plan.releases).releases[0]).not.toHaveProperty("key");
  });
});

describe("planChangelogIngest — date-sectioned", () => {
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

  test("empty before (missing since-sha) treats every section as added", () => {
    const plan = planChangelogIngest("", datedBefore, { urlTemplate });
    expect(plan.added).toEqual(["2026-06-09"]);
    expect(plan.modified).toEqual([]);
  });

  test("prose-only markdown is unparsable", () => {
    const md = readFixture("single-file/prose-only.md");
    expect(isUnparsableChangelog(md)).toBe(true);
    expect(planChangelogIngest("", md, { urlTemplate }).format).toBe("unknown");
  });
});

describe("isMissingOrZeroSha", () => {
  test("treats a missing or all-zero since SHA as a first publish", () => {
    expect(isMissingOrZeroSha(undefined)).toBe(true);
    expect(isMissingOrZeroSha(null)).toBe(true);
    expect(isMissingOrZeroSha("")).toBe(true);
    expect(isMissingOrZeroSha("0".repeat(40))).toBe(true);
    expect(isMissingOrZeroSha("abc123")).toBe(false);
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

  test("interpolates {slug} as an alias for key", () => {
    expect(
      renderUrlTemplate("https://x/{path}#{slug}", {
        key: "a",
        version: "",
        date: "",
        path: "changelog/a.mdx",
      }),
    ).toBe("https://x/changelog/a.mdx#a");
  });
});

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

const directoryUrl = "https://github.com/acme/site/blob/main/{path}";

describe("planDirectoryIngest — Mintlify-style fixtures", () => {
  test("flattens <Update>/<Callout> and strips the import line", () => {
    const files: DirectoryFileInput[] = [
      {
        path: "changelog/2026-06-01.mdx",
        status: "A",
        content: readFixture("mintlify/changelog/2026-06-01.mdx"),
      },
    ];
    const plan = planDirectoryIngest(files, {
      urlTemplate: directoryUrl,
      glob: "changelog/**/*.mdx",
    });
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
    const plan = planDirectoryIngest(files, {
      urlTemplate: directoryUrl,
      glob: "changelog/**/*.mdx",
    });
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
    const plan = planDirectoryIngest(files, {
      urlTemplate: directoryUrl,
      glob: "changelog/**/*.mdx",
    });
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
    const plan = planDirectoryIngest(files, {
      urlTemplate: directoryUrl,
      glob: "changelog/**/*.mdx",
    });
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
    const plan = planDirectoryIngest(files, { urlTemplate: directoryUrl, glob: "blog/**/*.mdx" });
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
      urlTemplate: directoryUrl,
      glob: "changelog/**/*.mdx",
    });
    expect(plan.added).toEqual(["new"]);
    expect(plan.modified).toEqual(["existing"]);
    expect(plan.deleted).toEqual(["changelog/gone.mdx"]);
    expect(plan.releases.map((r) => r.key)).toEqual(["new", "existing"]);
  });

  test("renames land as a modified entry at the new path", () => {
    const renamed: DirectoryFileInput = {
      path: "changelog/renamed-new.mdx",
      status: "M",
      content: "---\ntitle: Renamed\ndate: 2026-06-07\n---\n\nBody C",
    };
    const plan = planDirectoryIngest([renamed], {
      urlTemplate: directoryUrl,
      glob: "changelog/**/*.mdx",
    });
    expect(plan.modified).toEqual(["renamed-new"]);
    expect(plan.added).toEqual([]);
  });

  test("re-running the same input gives an identical batch body (stable key)", () => {
    const first = planDirectoryIngest([added, modified], {
      urlTemplate: directoryUrl,
      glob: "changelog/**/*.mdx",
    });
    const replay = planDirectoryIngest([added, modified], {
      urlTemplate: directoryUrl,
      glob: "changelog/**/*.mdx",
    });
    expect(toBatchBody(first.releases)).toEqual(toBatchBody(replay.releases));
    expect(toBatchRequest(first.releases)).toEqual(toBatchRequest(replay.releases));
    expect(first.releases.map((r) => r.url)).toEqual(replay.releases.map((r) => r.url));
  });
});

describe("parseFrontmatter", () => {
  test("splits the leading YAML block from the body", () => {
    const raw = [
      "---",
      "title: Hello",
      "date: 2026-06-01",
      "draft: false",
      "---",
      "",
      "Body text.",
      "",
    ].join("\n");
    const { data, body } = parseFrontmatter(raw);
    expect(data.title).toBe("Hello");
    expect(data.draft).toBe(false);
    expect(body.trim()).toBe("Body text.");
  });

  test("returns an empty frontmatter object when there is no leading block", () => {
    const { data, body } = parseFrontmatter("# Just markdown\n\nHello.\n");
    expect(data).toEqual({});
    expect(body).toBe("# Just markdown\n\nHello.\n");
  });

  test("keeps a plain YAML date as a string (no timezone shift)", () => {
    const { data } = parseFrontmatter("---\ndate: 2026-06-01\n---\nBody\n");
    expect(data.date).toBe("2026-06-01");
  });

  test("draft: true is readable from frontmatter", () => {
    const { data } = parseFrontmatter("---\ntitle: X\ndraft: true\n---\nBody\n");
    expect(data.draft).toBe(true);
  });

  test("an unreadable block yields empty data and keeps the body", () => {
    const { data, body } = parseFrontmatter("---\ntitle: Hello: world\n---\n\nBody\n");
    expect(data).toEqual({});
    expect(body.trim()).toBe("Body");
  });

  test("matches Bun.YAML on changelog frontmatter scalars", () => {
    const blocks = [
      "title: Hello\ndate: 2026-06-01\ndraft: false\n",
      "date: 2026-06-01\n",
      'date: "2026-06-01"\n',
      "draft: true\n",
      "draft: True\n",
      "version: 1.2.0\n",
      'version: "1.2.0"\n',
      "version: 1.2\n",
      'title: "Hello: world"\n',
      "a: 'it''s fine'\n",
      "n: null\n",
      "n: ~\n",
      "empty:\n",
      "title: Hello # comment\n",
      "slug: foo-bar\nurl: https://example.com/a#anchor\n",
      "publishedAt: 2026-06-02T12:00:00Z\n",
      "desc: |\n  line one\n  line two\nnext: x\n",
      "tags:\n  - a\n  - b\ntitle: T\n",
      "nested:\n  a: 1\ntitle: T\n",
      'title: "quote \\"hi\\""\n',
      "yesno: yes\n",
      "num: 01\n",
      'flag: "true"\n',
      "title: >\n  hello\n  world\nnext: y\n",
      "title: >-\n  hello\n  world\n",
      "version: 1.2.0-beta.1\n",
      "draft: true # skip\n",
    ];
    for (const block of blocks) {
      const bun = Bun.YAML.parse(block) as Record<string, unknown>;
      const ours = parseFrontmatter(`---\n${block}---\n`).data;
      for (const [key, value] of Object.entries(bun)) {
        if (value !== null && typeof value === "object") continue;
        expect(ours[key]).toEqual(value);
      }
      for (const key of [
        "title",
        "date",
        "draft",
        "version",
        "slug",
        "url",
        "publishedAt",
        "next",
      ]) {
        if (key in bun && (bun[key] === null || typeof bun[key] !== "object")) {
          expect(ours[key]).toEqual(bun[key]);
        }
      }
    }
  });
});

describe("flattenMdxToMarkdown", () => {
  test("strips import/export lines", () => {
    const body = [
      'import { Callout } from "@/components/callout"',
      "",
      "# Title",
      "",
      "Regular text.",
      "",
      "export const meta = { foo: 1 }",
      "",
    ].join("\n");
    const out = flattenMdxToMarkdown(body);
    expect(out).not.toContain("import ");
    expect(out).not.toContain("export ");
    expect(out).toContain("# Title");
    expect(out).toContain("Regular text.");
  });

  test("flattens a component to its text children", () => {
    const out = flattenMdxToMarkdown('<Callout type="info">Hi there</Callout>');
    expect(out).toBe("Hi there");
  });

  test("flattens nested components", () => {
    const out = flattenMdxToMarkdown("<Update>\n\n<Callout>Nested</Callout>\n\n</Update>");
    expect(out).toContain("Nested");
    expect(out).not.toContain("<Update>");
    expect(out).not.toContain("<Callout>");
  });

  test("drops self-closing components", () => {
    const out = flattenMdxToMarkdown(
      'Before\n\n<Video src="https://example.com/x.mp4" />\n\nAfter',
    );
    expect(out).not.toContain("<Video");
    expect(out).toContain("Before");
    expect(out).toContain("After");
  });

  test("converts img/Image tags to markdown images", () => {
    expect(flattenMdxToMarkdown('<img src="/a.png" alt="A" />')).toBe("![A](/a.png)");
    expect(flattenMdxToMarkdown('<Image src="/b.png" alt="B" />')).toBe("![B](/b.png)");
  });

  test("leaves fenced code blocks untouched", () => {
    const body = [
      "Some text with <Callout>should flatten</Callout>",
      "",
      "```jsx",
      '<Callout type="info">should NOT flatten</Callout>',
      "```",
      "",
      'More <Video src="x.mp4" />text',
    ].join("\n");
    const out = flattenMdxToMarkdown(body);
    expect(out).toContain("should flatten");
    expect(out).not.toContain("<Callout>should flatten");
    expect(out).toContain('<Callout type="info">should NOT flatten</Callout>');
    expect(out).toContain("```jsx");
  });

  test("leaves JSX-looking text inside inline code spans untouched", () => {
    const body = "Use `<Foo />` or `<Bar>x</Bar>` in `Map<K, V>`.";
    expect(flattenMdxToMarkdown(body)).toBe(body);
  });

  test("converts anchor tags to markdown links", () => {
    expect(flattenMdxToMarkdown('See <a href="https://x.dev" target="_blank">the docs</a>.')).toBe(
      "See [the docs](https://x.dev).",
    );
  });

  test("keeps regular markdown, links, and images as-is", () => {
    const body = "[a link](https://example.com) and a real image ![alt](https://example.com/x.png)";
    expect(flattenMdxToMarkdown(body)).toBe(body);
  });
});

describe("extractTitleHeading", () => {
  test("returns the first # heading", () => {
    expect(extractTitleHeading("# Hello World\n\nBody")).toBe("Hello World");
  });

  test("returns null when there is no h1", () => {
    expect(extractTitleHeading("## Not an h1\n\nBody")).toBeNull();
  });
});
