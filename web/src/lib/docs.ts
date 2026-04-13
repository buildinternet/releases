import fs from "node:fs";
import path from "node:path";
import { cache } from "react";
import matter from "gray-matter";

const DOCS_DIR = path.join(process.cwd(), "src", "content", "docs");

export type DocFrontmatter = {
  title: string;
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

export const loadDoc = cache((slug: string): Doc => {
  const filePath = path.join(DOCS_DIR, `${slug}.md`);
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
