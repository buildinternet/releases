import path from "node:path";
import { describe, expect, it } from "bun:test";
import { docMarkdown, mdxToMarkdown } from "./docs";

// docs-manifest reads content relative to process.cwd() at import time; pin it
// to apps/web for the import (same pattern as app/api/llms/route.test.ts).
const originalCwd = process.cwd();
if (path.basename(originalCwd) !== "web") process.chdir(path.join(originalCwd, "apps", "web"));
const { docsManifest, findLoadedDoc, parseMetaPages } = await import("./docs-manifest");
if (process.cwd() !== originalCwd) process.chdir(originalCwd);

describe("mdxToMarkdown", () => {
  const body = [
    "# Title",
    "",
    "<SkillsInstall />",
    "",
    "<McpInstallButtons />",
    "",
    "<AdminOnly>",
    "",
    "## Secret",
    "",
    "```bash",
    "releases admin",
    "```",
    "",
    "</AdminOnly>",
    "",
    "```tsx",
    "<Example />",
    "```",
    "",
    "Done.",
  ].join("\n");

  it("swaps components for their markdown fallback, or drops them", () => {
    const md = mdxToMarkdown(body, { includeAdmin: false });
    expect(md).toContain("npx skills add buildinternet/releases");
    expect(md).not.toContain("SkillsInstall");
    expect(md).not.toContain("McpInstallButtons");
  });

  it("drops <AdminOnly> blocks for the public and unwraps them for admins", () => {
    expect(mdxToMarkdown(body, { includeAdmin: false })).not.toContain("Secret");
    const admin = mdxToMarkdown(body, { includeAdmin: true });
    expect(admin).toContain("## Secret");
    expect(admin).toContain("releases admin");
    expect(admin).not.toContain("AdminOnly");
  });

  it("leaves JSX-looking lines inside code fences alone", () => {
    expect(mdxToMarkdown(body, { includeAdmin: false })).toContain("```tsx\n<Example />\n```");
  });

  it("collapses the blank lines a removed component leaves behind", () => {
    expect(mdxToMarkdown("a\n\n<McpInstallButtons />\n\nb", { includeAdmin: false })).toBe(
      "a\n\nb",
    );
  });
});

describe("docMarkdown", () => {
  it("keeps title/description and strips internal frontmatter", () => {
    const md = docMarkdown(
      {
        slug: "x",
        frontmatter: {
          title: "X",
          description: "D",
          label: "Short",
          adminOnly: false,
          og: { alt: "a", eyebrow: "e", title: "t" },
        },
        body: "Body",
      },
      { includeAdmin: false },
    );
    expect(md).toContain("title: X");
    expect(md).toContain("description: D");
    expect(md).not.toMatch(/label|adminOnly|og:|eyebrow/);
  });
});

describe("docs manifest", () => {
  it("parses Fumadocs meta.json separators and page paths", () => {
    expect(
      parseMetaPages(["---Intro---", "index", "./cli/browsing", "---API---", "./api/rest"]),
    ).toEqual([
      { slug: "index", section: "Intro" },
      { slug: "cli/browsing", section: "Intro" },
      { slug: "api/rest", section: "API" },
    ]);
  });

  it("rejects meta.json items it can't resolve to a page", () => {
    expect(() => parseMetaPages(["..."])).toThrow();
  });

  it("lists every docs page, with labels, and hides admin pages from the public", () => {
    const all = docsManifest({ includeAdmin: true });
    const pub = docsManifest({ includeAdmin: false });
    expect(all.find((e) => e.slug === "index")).toMatchObject({
      path: "/docs",
      mdPath: "/docs.md",
      label: "Overview",
    });
    expect(pub.some((e) => e.adminOnly)).toBe(false);
    expect(all.length).toBeGreaterThan(pub.length);
    for (const entry of all) expect(findLoadedDoc(entry.slug)?.frontmatter.title).toBeTruthy();
  });
});
