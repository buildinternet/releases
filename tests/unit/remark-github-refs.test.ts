import { describe, test, expect } from "bun:test";
import { remarkGithubRefs, githubRepoUrlFor } from "../../web/src/lib/remark-github-refs";

// Untyped mdast — @types/mdast isn't a direct dep at the repo root, and the
// shapes used here are simple enough that `any` is fine for tests.
/* eslint-disable @typescript-eslint/no-explicit-any */

function paragraph(value: string): any {
  return {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "text", value }] }],
  };
}

function runRefs(value: string, repoUrl: string | null = null): any[] {
  const tree = paragraph(value);
  const transformer = remarkGithubRefs({ repoUrl });
  transformer(tree);
  return tree.children[0].children;
}

function linkOf(children: any[], displayText: string): any {
  return children.find(
    (c) =>
      c.type === "link" &&
      c.children.length === 1 &&
      c.children[0].type === "text" &&
      c.children[0].value === displayText,
  );
}

describe("remarkGithubRefs", () => {
  test("linkifies @user mentions", () => {
    const out = runRefs("Thanks to @octocat and @hub-bot for the help.");
    expect(linkOf(out, "@octocat")?.url).toBe("https://github.com/octocat");
    expect(linkOf(out, "@hub-bot")?.url).toBe("https://github.com/hub-bot");
  });

  test("does not eat email local parts", () => {
    const out = runRefs("contact me at user@example.com");
    expect(linkOf(out, "@example")).toBeUndefined();
  });

  test("linkifies org/repo#NNN cross-repo references", () => {
    const out = runRefs("Fixes vercel/next.js#12345 and facebook/react#999.");
    expect(linkOf(out, "vercel/next.js#12345")?.url).toBe(
      "https://github.com/vercel/next.js/issues/12345",
    );
    expect(linkOf(out, "facebook/react#999")?.url).toBe(
      "https://github.com/facebook/react/issues/999",
    );
  });

  test("linkifies bare #NNN only when repoUrl is provided", () => {
    const withRepo = runRefs("Fixes #42 and #100.", "https://github.com/vercel/next.js");
    expect(linkOf(withRepo, "#42")?.url).toBe("https://github.com/vercel/next.js/issues/42");
    expect(linkOf(withRepo, "#100")?.url).toBe("https://github.com/vercel/next.js/issues/100");

    const withoutRepo = runRefs("Fixes #42 and #100.");
    expect(withoutRepo.every((c: any) => c.type !== "link")).toBe(true);
  });

  test("leaves existing inline code untouched", () => {
    const tree: any = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "See " },
            { type: "inlineCode", value: "#42" },
            { type: "text", value: " or " },
            { type: "inlineCode", value: "@user" },
          ],
        },
      ],
    };
    remarkGithubRefs({ repoUrl: "https://github.com/vercel/next.js" })(tree);
    expect(tree.children[0].children.some((c: any) => c.type === "link")).toBe(false);
  });

  test("trims trailing slash on repoUrl", () => {
    const out = runRefs("See #1.", "https://github.com/vercel/next.js/");
    expect(linkOf(out, "#1")?.url).toBe("https://github.com/vercel/next.js/issues/1");
  });
});

describe("githubRepoUrlFor", () => {
  test("extracts repo URL from a release tag URL", () => {
    expect(githubRepoUrlFor("https://github.com/vercel/next.js/releases/tag/v16.2.4")).toBe(
      "https://github.com/vercel/next.js",
    );
  });

  test("returns null for non-GitHub URLs", () => {
    expect(githubRepoUrlFor("https://gitlab.com/foo/bar")).toBeNull();
    expect(githubRepoUrlFor(null)).toBeNull();
    expect(githubRepoUrlFor(undefined)).toBeNull();
  });
});
