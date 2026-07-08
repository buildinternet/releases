/**
 * Changelog entry generator for published packages.
 *
 * Fork of `@changesets/changelog-github` without the "Thanks @user!" credit —
 * this monorepo is mostly single-maintainer, so the thanks line is noise on
 * every release. Still links PRs and commits.
 *
 * Config: `"changelog": ["./changelog.js", { "repo": "buildinternet/releases" }]`
 */
import { getInfo, getInfoFromPullRequest } from "@changesets/get-github-info";

const GITHUB_SERVER_URL = process.env.GITHUB_SERVER_URL || "https://github.com";

/**
 * @param {{ repo?: string }} options
 */
function requireRepo(options) {
  if (!options?.repo) {
    throw new Error(
      'Provide a repo to the changelog generator:\n"changelog": ["./changelog.js", { "repo": "org/repo" }]',
    );
  }
  return options.repo;
}

/** @type {import('@changesets/types').ChangelogFunctions} */
const changelogFunctions = {
  getDependencyReleaseLine: async (changesets, dependenciesUpdated, options) => {
    const repo = requireRepo(options);
    if (dependenciesUpdated.length === 0) return "";

    const links = await Promise.all(
      changesets.map(async (cs) => {
        if (!cs.commit) return null;
        const { links } = await getInfo({ repo, commit: cs.commit });
        return links.commit;
      }),
    );
    const changesetLink = `- Updated dependencies [${links.filter(Boolean).join(", ")}]:`;
    const updatedDependenciesList = dependenciesUpdated.map(
      (dependency) => `  - ${dependency.name}@${dependency.newVersion}`,
    );
    return [changesetLink, ...updatedDependenciesList].join("\n");
  },

  getReleaseLine: async (changeset, _type, options) => {
    const repo = requireRepo(options);

    let prFromSummary;
    let commitFromSummary;

    // Optional overrides in the changeset body (same as changelog-github):
    //   pr: #123
    //   commit: abcdef0
    //   author: @someone  (parsed but ignored — we don't credit in the line)
    const replacedChangelog = changeset.summary
      .replace(/^\s*(?:pr|pull|pull\s+request):\s*#?(\d+)/im, (_, pr) => {
        const num = Number(pr);
        if (!Number.isNaN(num)) prFromSummary = num;
        return "";
      })
      .replace(/^\s*commit:\s*([^\s]+)/im, (_, commit) => {
        commitFromSummary = commit;
        return "";
      })
      .replace(/^\s*(?:author|user):\s*@?([^\s]+)/gim, () => "")
      .trim();

    const [firstLine, ...futureLines] = replacedChangelog.split("\n").map((l) => l.trimEnd());

    const links = await (async () => {
      if (prFromSummary !== undefined) {
        let { links: prLinks } = await getInfoFromPullRequest({
          repo,
          pull: prFromSummary,
        });
        if (commitFromSummary) {
          const shortCommitId = commitFromSummary.slice(0, 7);
          prLinks = {
            ...prLinks,
            commit: `[\`${shortCommitId}\`](${GITHUB_SERVER_URL}/${repo}/commit/${commitFromSummary})`,
          };
        }
        return prLinks;
      }

      const commitToFetchFrom = commitFromSummary || changeset.commit;
      if (commitToFetchFrom) {
        const { links: commitLinks } = await getInfo({
          repo,
          commit: commitToFetchFrom,
        });
        return commitLinks;
      }

      return { commit: null, pull: null, user: null };
    })();

    // PR + commit only — no "Thanks @user!"
    const prefix = [
      links.pull === null ? "" : ` ${links.pull}`,
      links.commit === null ? "" : ` ${links.commit}`,
    ].join("");

    return `\n\n-${prefix ? `${prefix} -` : ""} ${firstLine}\n${futureLines
      .map((l) => `  ${l}`)
      .join("\n")}`;
  },
};

export default changelogFunctions;
