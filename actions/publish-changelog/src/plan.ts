/**
 * Re-export of `@buildinternet/releases-core/changelog-publish`.
 *
 * Relative path on purpose: the Action runs via `bun <action_path>/src/publish.ts`
 * from a GitHub checkout of this repo, with no `bun install`. The package
 * subpath is what the CLI imports once the package is published.
 */
export {
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
  releaseUrl,
  renderUrlTemplate,
  sectionToBatchRelease,
  toBatchBody,
  toBatchRequest,
  type BatchReleaseBody,
  type BatchUpsertRequest,
  type DirectoryFileInput,
  type DirectoryFileStatus,
  type DirectoryIngestPlan,
  type DirectoryPlanOptions,
  type Frontmatter,
  type IngestFormat,
  type IngestPlan,
  type ParsedMdx,
  type PlanOptions,
  type PlanUrlVars,
  type PlannedRelease,
} from "../../../packages/core/src/changelog-publish";
