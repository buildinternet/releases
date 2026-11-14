import fs from "node:fs";
import path from "node:path";
import { cache } from "react";
import matter from "gray-matter";
import { docFrontmatterSchema, type DocFrontmatter } from "@/lib/docs-schema";
import { apiPageMarkdown, parseIdList } from "@/lib/openapi-spec";

// Resolved from the process cwd: `apps/web/` under `next dev` / `next build`
// (the bundled module has no stable path of its own). The repo root is
// accepted too, so the root multi-dir `bun test` finds the same files no matter
// which test file imports this module first.
export const CONTENT_ROOT =
  [
    path.join(process.cwd(), "src", "content"),
    path.join(process.cwd(), "apps", "web", "src", "content"),
  ].find((dir) => fs.existsSync(dir)) ?? path.join(process.cwd(), "src", "content");

export type { DocFrontmatter };

/** Frontmatter keys that drive the site and never appear in served markdown. */
const INTERNAL_FRONTMATTER_KEYS = ["adminOnly", "label", "og", "navGroup", "apiMethod"] as const;

export type Doc = {
  slug: string;
  /** Docs frontmatter is schema-validated; static pages keep extra keys (e.g. `effectiveDate`). */
  frontmatter: DocFrontmatter & Record<string, unknown>;
  /** Raw body from the source file (no frontmatter). */
  body: string;
};

function readSource(dir: string, file: string) {
  return matter(fs.readFileSync(path.join(CONTENT_ROOT, dir, file), "utf8"));
}

// ── Static pages (`src/content/pages/*.md`) ─────────────────────────────────

export const loadPage = cache((slug: string): Doc => {
  const parsed = readSource("pages", `${slug}.md`);
  return { slug, frontmatter: parsed.data as Doc["frontmatter"], body: parsed.content };
});

/** Full markdown (frontmatter + body) for a static page's `.md` export and Copy page button. */
export function pageMarkdown(doc: Doc): string {
  return matter.stringify(doc.body.trimStart(), publicFrontmatter(doc.frontmatter));
}

// ── Docs (`src/content/docs/**\/*.mdx`) ─────────────────────────────────────

/**
 * Read a docs page's frontmatter and MDX source from disk. Rendering goes
 * through the compiled Fumadocs source (`@/lib/source`); this is for everything
 * that only needs metadata or text, and stays importable from `bun test`.
 */
export const loadDoc = cache((slug: string): Doc => {
  const parsed = readSource("docs", `${slug}.mdx`);
  return { slug, frontmatter: docFrontmatterSchema.parse(parsed.data), body: parsed.content };
});

/** Canonical URL for a docs slug. The `index` doc owns `/docs` itself. */
export function docPath(slug: string): string {
  return slug === "index" ? "/docs" : `/docs/${slug}`;
}

/** Raw-markdown URL for a docs slug (`/docs.md` for the index). */
export function docMdPath(slug: string): string {
  return `${docPath(slug)}.md`;
}

/**
 * Plain-markdown stand-ins for the interactive MDX components, used by the
 * `.md` export, llms-full.txt and the Copy page button so agents reading the
 * markdown still get the content. A component with no entry is dropped.
 * Keyed by the component name used in the `.mdx` files.
 */
const COMPONENT_MARKDOWN_FALLBACKS: Record<string, string | ((line: string) => string)> = {
  // `<APIPage operations="getOrgs" />` — the generated API reference pages.
  APIPage: (line) => apiPageMarkdown(parseIdList(line.match(/\boperations="([^"]*)"/)?.[1] ?? "")),
  SkillsInstall: [
    "**Standalone (any agent):**",
    "",
    "```bash",
    "npx skills add buildinternet/releases",
    "```",
    "",
    "Drops skill files into the project. Works in Claude Code, Codex, Cursor, OpenCode.",
    "",
    "**Claude Code plugin** (adds the bundled MCP server and `/releases` command):",
    "",
    "```bash",
    "/plugin marketplace add buildinternet/releases",
    "/plugin install releases@releases",
    "```",
  ].join("\n"),
};

/** A self-closing JSX component alone on its line, e.g. `<SkillsInstall />`. */
const SELF_CLOSING_COMPONENT = /^\s*<([A-Z][A-Za-z0-9]*)\b[^>]*\/>\s*$/;
const ADMIN_OPEN = /^\s*<AdminOnly>\s*$/;
const ADMIN_CLOSE = /^\s*<\/AdminOnly>\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
/** A single-line MDX comment, e.g. the generated-file notice. */
const MDX_COMMENT = /^\s*\{\/\*.*\*\/\}\s*$/;

/**
 * Turn a docs MDX body into plain markdown: `<AdminOnly>` blocks are kept
 * (markers removed) or dropped, and standalone components become their
 * markdown fallback. Lines inside fenced code blocks are left alone.
 */
export function mdxToMarkdown(body: string, { includeAdmin }: { includeAdmin: boolean }): string {
  const out: string[] = [];
  let fence: string | null = null;
  let adminDepth = 0;

  for (const line of body.split("\n")) {
    const hidden = adminDepth > 0 && !includeAdmin;
    const fenceMatch = line.match(FENCE);
    if (fence || fenceMatch) {
      if (!fence) fence = fenceMatch![1];
      else if (fenceMatch && fenceMatch[1].startsWith(fence)) fence = null;
      if (!hidden) out.push(line);
      continue;
    }
    if (ADMIN_OPEN.test(line)) {
      adminDepth++;
      continue;
    }
    if (ADMIN_CLOSE.test(line)) {
      adminDepth = Math.max(0, adminDepth - 1);
      continue;
    }
    if (hidden || MDX_COMMENT.test(line)) continue;

    const component = line.match(SELF_CLOSING_COMPONENT);
    if (component) {
      const fallback = COMPONENT_MARKDOWN_FALLBACKS[component[1]];
      if (fallback) out.push(typeof fallback === "function" ? fallback(line) : fallback);
      continue;
    }
    out.push(line);
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();
}

/**
 * Full public markdown for a docs page (frontmatter without internal keys +
 * flattened body): the `.md` export, llms-full.txt and the Copy page button.
 */
export function docMarkdown(doc: Doc, opts: { includeAdmin: boolean }): string {
  return matter.stringify(mdxToMarkdown(doc.body, opts), publicFrontmatter(doc.frontmatter));
}

function publicFrontmatter(frontmatter: DocFrontmatter): Record<string, unknown> {
  const out: Record<string, unknown> = { ...frontmatter };
  for (const key of INTERNAL_FRONTMATTER_KEYS) delete out[key];
  return out;
}
