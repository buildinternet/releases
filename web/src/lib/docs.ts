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

const SLOT_COMMENT_PATTERN = /<!--\s*slot:[a-z0-9-]+\s*-->\s*/gi;
const ADMIN_BLOCK_PATTERN = /<!--\s*admin:start\s*-->[\s\S]*?<!--\s*admin:end\s*-->\s*/gi;
const ADMIN_MARKER_PATTERN = /<!--\s*admin:(?:start|end)\s*-->\s*/gi;

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
  const bodyWithoutSlots = parsed.content
    .replace(SLOT_COMMENT_PATTERN, "")
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
