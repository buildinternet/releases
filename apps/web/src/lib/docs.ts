import fs from "node:fs";
import path from "node:path";
import { cache } from "react";
import matter from "gray-matter";

// Resolved from the process cwd: `apps/web/` under `next dev` / `next build`
// (the bundled module has no stable path of its own). The repo root is
// accepted too, so the root multi-dir `bun test` finds the same files no matter
// which test file imports this module first.
export const CONTENT_ROOT =
  [
    path.join(process.cwd(), "src", "content"),
    path.join(process.cwd(), "apps", "web", "src", "content"),
  ].find((dir) => fs.existsSync(dir)) ?? path.join(process.cwd(), "src", "content");

/** Open Graph card fields for a docs page with its own card (`/api/og/docs/<slug>`). */
export type DocOgCard = {
  alt: string;
  eyebrow: string;
  title: string;
  subtitle?: string;
  description?: string;
};

/** Mirrors the docs schema in `source.config.ts`. */
export type DocFrontmatter = {
  title: string;
  description?: string;
  /** Shorter sidebar / llms.txt link text. Defaults to `title`. */
  label?: string;
  adminOnly?: boolean;
  og?: DocOgCard;
};

/** Frontmatter keys that drive the site and never appear in served markdown. */
const INTERNAL_FRONTMATTER_KEYS = ["adminOnly", "label", "og"] as const;

export type Doc = {
  slug: string;
  frontmatter: DocFrontmatter;
  /** Raw body from the source file (no frontmatter). */
  body: string;
};

// ── Static pages (`src/content/pages/*.md`) ─────────────────────────────────

export const loadPage = cache((slug: string): Doc => {
  const raw = fs.readFileSync(path.join(CONTENT_ROOT, "pages", `${slug}.md`), "utf8");
  const parsed = matter(raw);
  return { slug, frontmatter: parsed.data as DocFrontmatter, body: parsed.content };
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
  const raw = fs.readFileSync(path.join(CONTENT_ROOT, "docs", `${slug}.mdx`), "utf8");
  const parsed = matter(raw);
  return { slug, frontmatter: parsed.data as DocFrontmatter, body: parsed.content };
});

/**
 * Plain-markdown stand-ins for the interactive MDX components, used by the
 * `.md` export, llms-full.txt and the Copy page button so agents reading the
 * markdown still get the content. A component with no entry is dropped.
 * Keyed by the component name used in the `.mdx` files.
 */
const COMPONENT_MARKDOWN_FALLBACKS: Record<string, string> = {
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
    const fenceMatch = line.match(FENCE);
    if (fence) {
      if (fenceMatch && fenceMatch[1].startsWith(fence)) fence = null;
      if (adminDepth === 0 || includeAdmin) out.push(line);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      if (adminDepth === 0 || includeAdmin) out.push(line);
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
    if (adminDepth > 0 && !includeAdmin) continue;

    const component = line.match(SELF_CLOSING_COMPONENT);
    if (component) {
      const fallback = COMPONENT_MARKDOWN_FALLBACKS[component[1]];
      if (fallback) out.push(fallback);
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
