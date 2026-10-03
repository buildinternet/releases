/**
 * The Action's planner is the published package. These fixtures are the
 * contract `releases publish` will reuse: same files, same plan.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import * as actionMdx from "../../actions/publish-changelog/src/mdx.ts";
import * as actionPlan from "../../actions/publish-changelog/src/plan.ts";
import * as shared from "@buildinternet/releases-core/changelog-publish";

const FIXTURES = resolve(import.meta.dir, "../../packages/core/fixtures/changelog-publish");

function readFixture(relPath: string): string {
  return readFileSync(resolve(FIXTURES, relPath), "utf8");
}

describe("action planner matches @buildinternet/releases-core/changelog-publish", () => {
  test("single-file since-sha diff", () => {
    const before = readFixture("single-file/keep-a-changelog-before.md");
    const after = readFixture("single-file/keep-a-changelog-after.md");
    const opts = {
      urlTemplate: "https://github.com/acme/sdk/blob/main/CHANGELOG.md#{key}",
      changelogPath: "CHANGELOG.md",
    };
    const fromAction = actionPlan.planChangelogIngest(before, after, opts);
    const fromShared = shared.planChangelogIngest(before, after, opts);
    expect(fromAction).toEqual(fromShared);
    expect(actionPlan.toBatchRequest(fromAction.releases)).toEqual(
      shared.toBatchRequest(fromShared.releases),
    );
    expect(actionPlan.isUnparsableChangelog(readFixture("single-file/prose-only.md"))).toBe(
      shared.isUnparsableChangelog(readFixture("single-file/prose-only.md")),
    );
  });

  test("empty before (missing since SHA) matches", () => {
    const after = readFixture("single-file/dated-after.md");
    const opts = {
      urlTemplate: "https://example.com/updates/{date}",
      changelogPath: "CHANGELOG.md",
    };
    expect(actionPlan.planChangelogIngest("", after, opts)).toEqual(
      shared.planChangelogIngest("", after, opts),
    );
    expect(actionPlan.isMissingOrZeroSha("0".repeat(40))).toBe(
      shared.isMissingOrZeroSha("0".repeat(40)),
    );
  });

  test("directory frontmatter fixtures match", () => {
    const files = [
      {
        path: "changelog/2026-06-01.mdx",
        status: "A" as const,
        content: readFixture("mintlify/changelog/2026-06-01.mdx"),
      },
      {
        path: "changelog/foo.mdx",
        status: "M" as const,
        content: readFixture("fumadocs/changelog/foo.mdx"),
      },
      {
        path: "changelog/2026-06-04-draft.mdx",
        status: "A" as const,
        content: readFixture("mintlify/changelog/2026-06-04-draft.mdx"),
      },
      {
        path: "blog/2026-06-03-cool-thing/index.mdx",
        status: "A" as const,
        content: readFixture("fumadocs/blog/2026-06-03-cool-thing/index.mdx"),
      },
      { path: "changelog/gone.mdx", status: "D" as const },
    ];
    const opts = {
      urlTemplate: "https://github.com/acme/site/blob/main/{path}",
      glob: "changelog/**/*.mdx",
    };
    expect(actionPlan.planDirectoryIngest(files, opts)).toEqual(
      shared.planDirectoryIngest(files, opts),
    );
  });

  test("mdx helpers match", () => {
    const raw = readFixture("fumadocs/changelog/foo.mdx");
    expect(actionMdx.parseFrontmatter(raw)).toEqual(shared.parseFrontmatter(raw));
    const { body } = shared.parseFrontmatter(raw);
    expect(actionMdx.flattenMdxToMarkdown(body)).toBe(shared.flattenMdxToMarkdown(body));
    expect(actionMdx.extractTitleHeading(body)).toBe(shared.extractTitleHeading(body));
  });
});
