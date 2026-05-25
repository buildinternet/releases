import remarkGfm from "remark-gfm";
import remarkGemoji from "remark-gemoji";
import { remarkGithubAlerts } from "./remark-github-alerts";
import { remarkGithubRefs } from "./remark-github-refs";

export { githubRepoUrlFor } from "./remark-github-refs";
export { remarkGithubAlerts } from "./remark-github-alerts";
export { remarkGithubRefs } from "./remark-github-refs";

interface RemarkPluginOptions {
  /** Repo URL for resolving bare `#123` issue/PR references. Pass on detail
   *  pages and changelog views where the source repo is unambiguous; leave
   *  unset on lists, search, and other multi-source surfaces. */
  repoUrl?: string | null;
}

/**
 * Standard remark plugin set for rendering changelog content.
 *
 * - `remark-gfm`         tables, strikethrough, autolinks, task lists, footnotes
 * - `remark-gemoji`      `:smile:` shortcodes
 * - `remarkGithubAlerts` `> [!NOTE]` / `[!WARNING]` callouts
 * - `remarkGithubRefs`   `@user`, `org/repo#123`, and (with repoUrl) bare `#123`
 *
 * Use this everywhere we render user-facing markdown so formatting stays
 * consistent across release detail, lists, search, etc.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createRemarkPlugins(options: RemarkPluginOptions = {}): any[] {
  return [
    remarkGfm,
    remarkGemoji,
    remarkGithubAlerts,
    [remarkGithubRefs, { repoUrl: options.repoUrl ?? null }],
  ];
}

/** Default plugin set with no source-repo context — safe for any surface. */
export const remarkPlugins = createRemarkPlugins();
