/**
 * Re-export of the directory-mode MDX helpers on
 * `@buildinternet/releases-core/changelog-publish`. Relative path so the
 * Action runs from a GitHub checkout without installing the package.
 */
export {
  extractTitleHeading,
  flattenMdxToMarkdown,
  parseFrontmatter,
  type Frontmatter,
  type ParsedMdx,
} from "../../../packages/core/src/changelog-publish";
