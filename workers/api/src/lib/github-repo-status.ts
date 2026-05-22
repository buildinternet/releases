/**
 * Pre-flight check for "can we actually read this GitHub repo right now?",
 * shared by the changelog probe (source-scoped) and the changelog fetch
 * (coordinate-based) routes.
 *
 * The CHANGELOG planner (`discoverChangelogPaths`) swallows every upstream
 * failure into an empty result, so on its own a caller can't tell "no
 * CHANGELOG found" apart from "we couldn't reach the repo." A single
 * `GET /repos/:owner/:repo` up front disambiguates the four states callers
 * care about:
 *
 * - 404 → repo doesn't exist            → respond 404
 * - 401/403 → auth / permission failure → respond 502
 * - 429 → rate-limited                  → respond 503
 * - 5xx / network error                 → respond 502
 */
export type RepoStatus =
  | { kind: "ok" }
  | { kind: "fail"; status: 404 | 502 | 503; body: { error: string; message: string } };

export async function classifyRepoStatus(
  ownerRepo: { owner: string; repo: string },
  apiHeaders: Record<string, string>,
): Promise<RepoStatus> {
  const { owner, repo } = ownerRepo;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: apiHeaders });
  } catch (err) {
    return {
      kind: "fail",
      status: 502,
      body: {
        error: "github_upstream_error",
        message: `GitHub network error: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  if (res.ok) return { kind: "ok" };
  if (res.status === 404) {
    return {
      kind: "fail",
      status: 404,
      body: { error: "repo_not_found", message: `${owner}/${repo} not found on GitHub` },
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      kind: "fail",
      status: 502,
      body: {
        error: "github_auth_error",
        message: `GitHub returned ${res.status} for ${owner}/${repo}`,
      },
    };
  }
  if (res.status === 429) {
    return {
      kind: "fail",
      status: 503,
      body: { error: "github_rate_limited", message: "GitHub rate limit exceeded" },
    };
  }
  return {
    kind: "fail",
    status: 502,
    body: {
      error: "github_upstream_error",
      message: `GitHub returned ${res.status} for ${owner}/${repo}`,
    },
  };
}
