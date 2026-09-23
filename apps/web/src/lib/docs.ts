import fs from "node:fs";
import path from "node:path";
import { cache } from "react";
import matter from "gray-matter";

const CONTENT_ROOT = path.join(process.cwd(), "src", "content");

export type DocFrontmatter = {
  title: string;
  description?: string;
  adminOnly?: boolean;
};

export type Doc = {
  slug: string;
  /** Parsed frontmatter including internal-only fields like `adminOnly`. */
  frontmatter: DocFrontmatter;
  /** Raw body from the `.md` source (no frontmatter), preserving slot markers for in-page rendering. */
  body: string;
  /** Full markdown safe for public serving: frontmatter (without internal-only fields) + body with slot markers stripped. */
  public: string;
};

const SLOT_COMMENT_PATTERN = /<!--\s*slot:([a-z0-9-]+)\s*-->/gi;
const ADMIN_BLOCK_PATTERN = /<!--\s*admin:start\s*-->[\s\S]*?<!--\s*admin:end\s*-->\s*/gi;
const ADMIN_MARKER_PATTERN = /<!--\s*admin:(?:start|end)\s*-->\s*/gi;

/**
 * Markdown fallbacks for interactive slots. The rendered React page swaps these
 * out for live components, but the `.md` export and the "Copy page" button need
 * the equivalent content inline so consumers ingesting markdown still see it.
 */
const SLOT_MARKDOWN_FALLBACKS: Record<string, string> = {
  "skills-install": [
    "**Standalone (any agent):**",
    "",
    "```bash",
    "npx skills add buildinternet/releases-cli",
    "```",
    "",
    "Drops skill files into the project. Works in Claude Code, Codex, Cursor, OpenCode.",
    "",
    "**Claude Code plugin** (adds the bundled MCP server and `/releases` command):",
    "",
    "```bash",
    "/plugin marketplace add buildinternet/releases-cli",
    "/plugin install releases@releases",
    "```",
  ].join("\n"),
};

function replaceSlotsForMarkdown(content: string): string {
  return content.replace(SLOT_COMMENT_PATTERN, (_match, name: string) => {
    const fallback = SLOT_MARKDOWN_FALLBACKS[name.toLowerCase()];
    return fallback ?? "";
  });
}

/** Strip `<!-- admin:start --> ... <!-- admin:end -->` blocks from markdown. */
export function stripAdminBlocks(content: string): string {
  return content.replace(ADMIN_BLOCK_PATTERN, "").replace(/\n{3,}/g, "\n\n");
}

/** Remove admin markers but keep their enclosed content (for admin viewers). */
export function keepAdminBlocks(content: string): string {
  return content.replace(ADMIN_MARKER_PATTERN, "");
}

export const loadMarkdown = cache((dir: string, slug: string): Doc => {
  const filePath = path.join(CONTENT_ROOT, dir, `${slug}.md`);
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = matter(raw);
  const { adminOnly: _adminOnly, ...publicFrontmatter } = parsed.data as DocFrontmatter;
  const bodyWithoutSlots = replaceSlotsForMarkdown(parsed.content)
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();
  return {
    slug,
    frontmatter: parsed.data as DocFrontmatter,
    body: parsed.content,
    public: matter.stringify(bodyWithoutSlots, publicFrontmatter),
  };
});

export const loadDoc = (slug: string): Doc => loadMarkdown("docs", slug);
export const loadPage = (slug: string): Doc => loadMarkdown("pages", slug);
